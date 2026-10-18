import type { MeetingItem } from "../meetings/types.ts";
import type {
  Confidence, EvidenceState, IntelItem, ItemKind, ItemStatus, Owner, ProposalKind, Provenance, ReadinessLevel, SourceHealth,
} from "./types.ts";
import { hash, itemId, type IntelStore } from "./store.ts";
import { titleMatches } from "./scope.ts";
import { draftOutcome } from "./outcome.ts";
import { closableIntelItem } from "../triage/links.ts";

/** Everything the reconciler reads for one project. Gathered by the caller so tests need no live sources. */
export type PlanMilestoneInput = {
  id: string; position: number; title: string; outcome: string; acceptance: string[];
  status: "pending" | "blocked" | "reported-complete"; blockedReason: string | null; dependencies: number[];
};
export type ReconcileInput = {
  projectId: string;
  projectName: string;
  goal: string | null;
  summary: { recentFocus: string | null; completed: string | null; unfinished: string | null } | null;
  commits: { subject: string; at: string | null }[];
  tasks: { id: string; title: string; status: string; summary: string | null; updatedAt: string | null }[];
  meetingItems: MeetingItem[];
  meetings: { recordingId: string; title: string; at: string; headline: string | null }[];
  milestones: PlanMilestoneInput[];
  sources: SourceHealth[];
};

/** Optional enrichment hook. Off by default; nothing in the core rules or the tests calls a model. */
export type ExtraFact = { kind: ItemKind; title: string; detail?: string | null; owner?: Owner; dueDate?: string | null; provenance: Provenance };
export type IntelModelHook = { extraFacts(input: ReconcileInput): Promise<ExtraFact[]> };

export type ReconcileReport = { projectId: string; itemsAdded: number; itemsUpdated: number; proposalsCreated: number; degraded: boolean };

type Fact = {
  kind: ItemKind; title: string; detail: string | null; owner: Owner; dueDate: string | null; acceptance: string[];
  prov: Provenance; closing: "done" | "dropped" | null; fromPlan: PlanMilestoneInput | null;
  /** Who set the meeting item's status (meeting facts only). */
  statusSource?: MeetingItem["statusSource"];
};

const RESOURCE = /(credential|api[ -]?key|password|login|access|token|permission|sandbox|account|secret|certificate|dns|whitelist|invite)/i;
const CUE = /(need|waiting|wait|require|depend|blocked|until|provide|send|share|give|from (the )?(client|them|you)|client (will|to|has to)|they('ll| will| need))/i;
const SELF_OK = /need|waiting|require|depend|blocked|from (the )?(client|them|you)/i;
const THIRD = /\b(vendor|third.party|provider|bank|registrar|dns)\b/i;
const EXCLUDE = /(out of scope|won't|will not|not (doing|building|include|part)|exclud|descop|no longer)/i;

export const isBlockerText = (text: string, kind: MeetingItem["kind"], speaker: MeetingItem["speakerRole"]): boolean => {
  if (kind === "decision" || !RESOURCE.test(text) || !CUE.test(text)) return false;
  return !(kind === "commitment" && speaker === "me" && !SELF_OK.test(text));
};

const day = (iso: string): string => iso.slice(0, 10);
const CLOSED_BY_YOU = "Closed by you in Meetings";

function meetingProv(m: MeetingItem): Provenance {
  const at = m.meetingAt || m.createdAt;
  const confidence: Confidence = m.projectSource === "user" || m.edited ? "high" : "medium";
  return {
    sourceKind: "meeting", sourceId: m.id, label: `${m.meetingTitle || "Meeting"}, ${day(at)}`, quote: m.quote || null,
    observedAt: at, confidence, link: `#meetings?rec=${m.recordingId}`,
  };
}

function meetingFact(m: MeetingItem): Fact | null {
  const closing: Fact["closing"] = m.status === "done" ? "done" : m.status === "dropped" ? "dropped" : null;
  const prov = meetingProv(m);
  const owner: Owner = m.speakerRole === "me" || m.speakerRole === "teammate" ? "me" : m.speakerRole === "client" ? "client" : "unknown";
  const base = { detail: null, acceptance: [] as string[], closing, prov, fromPlan: null, statusSource: m.statusSource };
  if (isBlockerText(m.text, m.kind, m.speakerRole)) {
    return { ...base, kind: "blocker", title: m.text, owner: THIRD.test(m.text) ? "third_party" : "client", dueDate: m.dueDate };
  }
  if (m.kind === "commitment") return { ...base, kind: "commitment", title: m.text, owner, dueDate: m.dueDate };
  if (m.kind === "decision") return { ...base, kind: EXCLUDE.test(m.text) ? "exclusion" : "decision", title: m.text, owner: "unknown", dueDate: null };
  return {
    ...base, kind: "requirement", title: m.feature?.title ?? m.text, detail: m.feature ? m.feature.outcome : m.text,
    acceptance: m.feature?.acceptance ?? [], owner: "unknown", dueDate: m.dueDate,
  };
}

function planFacts(input: ReconcileInput): Fact[] {
  return input.milestones.map((ms) => ({
    kind: "milestone" as const, title: ms.title, detail: ms.outcome, owner: "me" as Owner, dueDate: null, acceptance: ms.acceptance,
    closing: null, fromPlan: ms,
    prov: { sourceKind: "delivery-plan" as const, sourceId: ms.id, label: `Delivery plan: ${ms.title}`, quote: null, observedAt: "1970-01-01T00:00:00.000Z", confidence: "high" as const, link: null },
  }));
}

const provKey = (p: Provenance): string => `${p.sourceKind}:${p.sourceId ?? p.label}`;
function withProv(list: Provenance[], p: Provenance): Provenance[] | null {
  return list.some((x) => provKey(x) === provKey(p)) ? null : [...list, p];
}
const maxAt = (list: Provenance[], fallback: string): string => list.reduce((a, p) => (p.observedAt > a ? p.observedAt : a), fallback);

/** Top-level pass for one project. Pure rules over stored state + input; idempotent for identical input. */
export function reconcileProject(store: IntelStore, input: ReconcileInput, now: Date, extra: ExtraFact[] = []): ReconcileReport {
  const at = now.toISOString();
  const report: ReconcileReport = { projectId: input.projectId, itemsAdded: 0, itemsUpdated: 0, proposalsCreated: 0, degraded: input.sources.some((s) => s.state !== "ok") };
  return store.tx(() => {
    const propose = (p: Parameters<IntelStore["addProposal"]>[0]): void => {
      const made = store.addProposal(p, at);
      if (!made) return;
      report.proposalsCreated++;
      store.addChange({ projectId: input.projectId, kind: "proposal_created", summary: p.summary, itemId: p.itemId ?? null, sources: (p.provenance ?? []).map((x) => x.label) }, at);
    };
    const facts = [...input.meetingItems.map(meetingFact).filter((f): f is Fact => f !== null), ...planFacts(input),
      ...extra.map((e): Fact => ({ kind: e.kind, title: e.title, detail: e.detail ?? null, owner: e.owner ?? "unknown", dueDate: e.dueDate ?? null, acceptance: [], closing: null, fromPlan: null, prov: e.provenance }))]
      .sort((a, b) => a.prov.observedAt.localeCompare(b.prov.observedAt) || String(a.prov.sourceId).localeCompare(String(b.prov.sourceId)));
    const closedMeetingIds = new Set(input.meetingItems.filter((m) => m.status === "done" || m.status === "dropped").map((m) => m.id));
    const planIds = new Map(input.milestones.map((m) => [m.position, itemId(input.projectId, "milestone", m.title)]));

    // A single meeting stating one commitment with two different dates is a conflict, not an update.
    const dates = new Map<string, Set<string>>();
    for (const f of facts) {
      if (f.dueDate && f.prov.sourceKind === "meeting") {
        const k = `${itemId(input.projectId, f.kind, f.title)}|${f.prov.observedAt}`;
        dates.set(k, (dates.get(k) ?? new Set()).add(f.dueDate));
      }
    }

    for (const f of facts) {
      const id = itemId(input.projectId, f.kind, f.title);
      const existing = store.item(id);
      const conflictDates = f.dueDate ? dates.get(`${id}|${f.prov.observedAt}`) : undefined;
      if (conflictDates && conflictDates.size > 1) {
        propose({ projectId: input.projectId, kind: "conflict", material: true, itemId: existing?.id ?? null,
          summary: `Conflicting dates for "${f.title}": ${[...conflictDates].sort().join(" vs ")}`,
          detail: "The same meeting states different dates. Nothing was changed; pick the right one.", patch: { op: "ack" }, provenance: [f.prov] });
        continue;
      }
      if (!existing) { addNew(f, id); continue; }
      updateExisting(existing, f);
    }

    function addNew(f: Fact, id: string): void {
      if (f.closing) return; // never create something that is already closed
      if (f.kind === "requirement") {
        propose({ projectId: input.projectId, kind: "new_requirement", material: true, itemId: id,
          summary: `New requirement: ${f.title}`, detail: f.detail,
          patch: { op: "create_item", item: { kind: "requirement", title: f.title, detail: f.detail, owner: "unknown", dueDate: f.dueDate, acceptance: f.acceptance } },
          provenance: [f.prov] });
        return;
      }
      const ms = f.fromPlan;
      const done = ms?.status === "reported-complete";
      const evidence: EvidenceState = done ? "unverified" : ms?.status === "blocked" ? "blocked" : f.kind === "blocker" || f.kind === "decision" || f.kind === "exclusion" ? "unknown" : "not_implemented";
      const item: IntelItem = {
        id, projectId: input.projectId, kind: f.kind, title: f.title, detail: f.detail, basis: "inferred",
        status: done || f.kind === "decision" || f.kind === "exclusion" ? "done" : "open", evidenceState: evidence,
        readinessTarget: f.kind === "milestone" ? "usable_by_client" : null, readinessReached: null, owner: f.owner, dueDate: f.dueDate,
        acceptance: f.acceptance, dependsOn: ms ? ms.dependencies.map((d) => planIds.get(d)).filter((x): x is string => !!x) : [],
        locked: false, provenance: [f.prov], lastSupportedAt: f.prov.observedAt === "1970-01-01T00:00:00.000Z" ? at : f.prov.observedAt, createdAt: at, updatedAt: at,
        lane: null, goal: null, verifiedAt: null, sentAt: null, reopenCount: 0,
      };
      store.insertItem(item, f.title);
      report.itemsAdded++;
      store.addChange({ projectId: input.projectId, kind: "item_added", summary: `Added ${f.kind}: ${f.title} (inferred)`, itemId: id, sources: [f.prov.label] }, at);
      if (f.kind === "commitment") {
        propose({ projectId: input.projectId, kind: "new_commitment", material: true, itemId: id,
          summary: `Confirm commitment: ${f.title}${f.dueDate ? ` (due ${f.dueDate})` : ""}`, detail: "Inferred from a meeting. Accepting confirms and locks it.",
          patch: { op: "update_item", itemId: id, fields: { basis: "confirmed", locked: true } }, provenance: [f.prov] });
      }
    }

    function updateExisting(item: IntelItem, f: Fact): void {
      const isPlan = f.fromPlan !== null;
      const protectedItem = item.locked || item.basis === "confirmed";
      const next: IntelItem = { ...item };
      let changed = false;
      // Material: deadline changes (only from genuinely newer evidence, or the same source revised).
      if (f.dueDate && f.dueDate !== item.dueDate && (item.provenance.some((p) => provKey(p) === provKey(f.prov)) || f.prov.observedAt > item.lastSupportedAt)) {
        propose({ projectId: input.projectId, kind: "deadline_change", material: true, itemId: item.id,
          summary: `Deadline for "${item.title}" ${item.dueDate ? `moved ${item.dueDate} → ${f.dueDate}` : `set to ${f.dueDate}`}`,
          patch: { op: "update_item", itemId: item.id, fields: { dueDate: f.dueDate } }, provenance: [f.prov] });
      }
      // You closed the meeting item yourself: an inferred, unlocked item backed only by closed meetings follows directly.
      let closedByYou = false;
      if (f.closing && f.prov.sourceKind === "meeting" && f.statusSource === "user" && item.basis === "inferred" && closableIntelItem(item, closedMeetingIds)) {
        closedByYou = true;
        next.status = f.closing === "done" ? "done" : "obsolete";
        changed = true;
        for (const p of store.proposals(input.projectId)) {
          if (p.status === "pending" && p.itemId === item.id) store.resolveProposal(p.id, "rejected", CLOSED_BY_YOU, at);
        }
        store.addChange({ projectId: input.projectId, kind: "item_updated", summary: `"${item.title}" ${f.closing === "done" ? "done" : "dropped"}: ${CLOSED_BY_YOU.toLowerCase()}`, itemId: item.id, sources: [f.prov.label] }, at);
      } else if (f.closing && !["done", "dropped", "obsolete"].includes(item.status)) {
        const done = f.closing === "done";
        propose({ projectId: input.projectId, kind: done ? "mark_complete" : "mark_obsolete", material: true, itemId: item.id,
          summary: done ? `Mark done: ${item.title}` : `Drop as obsolete: ${item.title}`,
          detail: done ? "A meeting recorded this as done. Completion is not verified acceptance." : "A meeting recorded this as dropped.",
          patch: { op: "update_item", itemId: item.id, fields: { status: done ? "done" : "obsolete" } }, provenance: [f.prov] });
      }
      if (isPlan && f.fromPlan) {
        const ms = f.fromPlan;
        const planStatus: ItemStatus = ms.status === "reported-complete" ? "done" : "open";
        const planEvidence: EvidenceState | null = ms.status === "reported-complete" ? (item.evidenceState === "verified" ? "verified" : item.evidenceState === "implementation_observed" ? "implementation_observed" : "unverified")
          : ms.status === "blocked" ? "blocked" : item.evidenceState === "blocked" ? "not_implemented" : null;
        const statusDiffers = planStatus !== item.status && !(item.status === "in_progress" && planStatus === "open");
        if (protectedItem && (statusDiffers || (planEvidence === "blocked" && item.evidenceState !== "blocked"))) {
          if (item.locked || item.basis === "confirmed") {
            propose({ projectId: input.projectId, kind: "conflict", material: true, itemId: item.id,
              summary: `Plan and record disagree on "${item.title}": plan says ${ms.status}, record says ${item.status}/${item.evidenceState}`,
              detail: "The record was confirmed or locked by a person, so it was left unchanged.",
              patch: { op: "update_item", itemId: item.id, fields: { status: planStatus } }, provenance: [f.prov] });
          }
        } else if (!protectedItem) {
          if (statusDiffers) { next.status = planStatus; changed = true; }
          if (planEvidence && planEvidence !== item.evidenceState) { next.evidenceState = planEvidence; changed = true; }
          const acc = JSON.stringify(ms.acceptance);
          if (acc !== JSON.stringify(item.acceptance)) { next.acceptance = ms.acceptance; changed = true; }
          if (ms.outcome !== item.detail) { next.detail = ms.outcome; changed = true; }
          const deps = ms.dependencies.map((d) => planIds.get(d)).filter((x): x is string => !!x);
          if (JSON.stringify(deps) !== JSON.stringify(item.dependsOn)) { next.dependsOn = deps; changed = true; }
        }
      }
      // A non-locked item gains provenance for each new supporting source; locked ones stay frozen.
      if (!item.locked && !isPlan) {
        const merged = withProv(item.provenance, f.prov);
        if (merged) { next.provenance = merged; next.lastSupportedAt = maxAt(merged, item.lastSupportedAt); changed = true; }
      }
      if (closedByYou) {
        const human: Provenance = { sourceKind: "human", sourceId: null, label: CLOSED_BY_YOU, quote: null, observedAt: at, confidence: "high", link: null };
        next.provenance = withProv(next.provenance, human) ?? next.provenance;
      }
      if (changed) {
        next.updatedAt = at;
        store.updateItem(next);
        report.itemsUpdated++;
        if (isPlan) store.addChange({ projectId: input.projectId, kind: "item_updated", summary: `Plan change applied to "${item.title}"`, itemId: item.id, sources: [f.prov.label] }, at);
      }
    }

    applyCodeEvidence();

    function applyCodeEvidence(): void {
      const evidence = [
        ...input.commits.map((c) => ({ text: c.subject, label: `Commit: ${c.subject}`, id: hash("git", c.subject), at: c.at ?? at, kind: "git" as const })),
        ...input.tasks.filter((t) => t.status === "done").map((t) => ({ text: `${t.title} ${t.summary ?? ""}`, label: `Agent task done: ${t.title}`, id: `task:${t.id}`, at: t.updatedAt ?? at, kind: "agent-task" as const })),
      ];
      if (!evidence.length) return;
      for (const item of store.items(input.projectId)) {
        if ((item.kind !== "requirement" && item.kind !== "milestone") || item.status === "dropped" || item.status === "obsolete") continue;
        if (!["not_implemented", "unknown", "unverified"].includes(item.evidenceState)) continue;
        const hit = evidence.find((e) => titleMatches(item.title, e.text));
        if (!hit) continue;
        const prov: Provenance = { sourceKind: hit.kind, sourceId: hit.id, label: hit.label, quote: null, observedAt: hit.at, confidence: "medium", link: null };
        if (item.locked) {
          propose({ projectId: input.projectId, kind: "mark_complete", material: true, itemId: item.id,
            summary: `Code evidence suggests "${item.title}" is implemented (not verified)`, detail: "Locked item: left unchanged until you accept.",
            patch: { op: "update_item", itemId: item.id, fields: { evidenceState: "implementation_observed" } }, provenance: [prov] });
          continue;
        }
        const merged = withProv(item.provenance, prov) ?? item.provenance;
        // Code evidence is never proof of acceptance: it can only reach implementation_observed.
        store.updateItem({ ...item, evidenceState: "implementation_observed", provenance: merged, updatedAt: at });
        report.itemsUpdated++;
        store.addChange({ projectId: input.projectId, kind: "item_updated", summary: `Implementation observed for "${item.title}" (not verified)`, itemId: item.id, sources: [hit.label] }, at);
      }
    }

    draftOutcome(store, input, at, propose);

    const previous = store.reconciled(input.projectId);
    const sig = (s: SourceHealth[]): string => s.map((x) => `${x.source}:${x.state}`).join(",");
    if (report.degraded && (!previous || sig(previous.sources) !== sig(input.sources))) {
      store.addChange({ projectId: input.projectId, kind: "reconcile_degraded",
        summary: `Kept stored plan; degraded sources: ${input.sources.filter((s) => s.state !== "ok").map((s) => `${s.source} (${s.state})`).join(", ")}`, sources: [] }, at);
    }
    store.saveReconciled(input.projectId, at, input.sources);
    return report;
  });
}

export type { ReadinessLevel, ProposalKind };
