import type { Db } from "../db/index.ts";
import type { Portfolio, PortfolioProject } from "../shared/types.ts";
import { deliveryRepo } from "../db/delivery-repo.ts";
import { meetingStore } from "../meetings/store.ts";
import type { MeetingItem } from "../meetings/types.ts";
import type {
  Basis, ChangeEntry, EvidenceState, FocusState, Freshness, IntelItem, ItemKind, ItemStatus, Objective, Owner, ProjectFocusRow, ProjectIntel,
  ProjectOutcome, Proposal, ReadinessLevel, SourceHealth, DeliveryStage,
} from "./types.ts";
import { READINESS_LEVELS } from "./types.ts";
import { intelStore, itemId, type IntelStore } from "./store.ts";
import { reconcileProject, type IntelModelHook, type ReconcileInput, type ReconcileReport } from "./reconcile.ts";
import { deriveReadiness, deriveStage, projectOutcome } from "./outcome.ts";
import { computeGaps, prioritizeAll, type PrioritizeProject, type ProjectObjectives } from "./prioritize.ts";

export class IntelError extends Error {
  readonly code: "invalid" | "not-found" | "conflict";
  constructor(code: IntelError["code"], message: string) { super(message); this.code = code; }
}

export const ITEM_KINDS: readonly ItemKind[] = ["requirement", "milestone", "commitment", "blocker", "decision", "exclusion"];
export const ITEM_STATUSES: readonly ItemStatus[] = ["open", "in_progress", "done", "dropped", "obsolete"];
export const EVIDENCE_STATES: readonly EvidenceState[] = ["not_implemented", "implementation_observed", "unverified", "verified", "blocked", "unknown"];
export const OWNERS: readonly Owner[] = ["me", "client", "third_party", "unknown"];

const AGING_MS = 2 * 3_600_000;
const STALE_MS = 24 * 3_600_000;

export type IntelServiceOptions = {
  latest: () => Portfolio | null;
  now?: () => Date;
  /** Off by default. Core rules never need it; tests never provide one. */
  hook?: IntelModelHook;
  intervalMs?: number;
};

export type ItemFields = Partial<{
  title: string; detail: string | null; status: ItemStatus; evidenceState: EvidenceState; owner: Owner; dueDate: string | null;
  acceptance: string[]; locked: boolean; readinessReached: ReadinessLevel | null; confirm: boolean;
}>;

export function intelService(db: Db, options: IntelServiceOptions) {
  const now = options.now ?? (() => new Date());
  const projectName = (id: string): string => {
    const p = findProject(id);
    if (p) return p.name;
    const row = db.prepare("SELECT canonical_path FROM projects WHERE id=?").get(id) as { canonical_path?: string } | undefined;
    return row?.canonical_path ? (row.canonical_path.split(/[\\/]/).filter(Boolean).pop() ?? id) : id;
  };
  const store: IntelStore = intelStore(db, projectName);
  const meetings = meetingStore(db);
  let timer: ReturnType<typeof setInterval> | null = null;

  function allProjects(): PortfolioProject[] { const l = options.latest(); return l ? [...l.active, ...l.other] : []; }
  function findProject(id: string): PortfolioProject | undefined { return allProjects().find((p) => p.id === id); }
  function knownProject(id: string): boolean {
    return !!findProject(id) || !!db.prepare("SELECT 1 FROM projects WHERE id=?").get(id) || store.items(id).length > 0 || !!store.outcome(id);
  }
  function projectIds(): string[] {
    const ids = new Set(allProjects().map((p) => p.id));
    for (const i of store.allItems()) ids.add(i.projectId);
    for (const id of store.outcomeProjects()) ids.add(id);
    for (const p of store.pendingProposals()) ids.add(p.projectId);
    return [...ids].sort();
  }

  function sourceHealth(): SourceHealth[] {
    const out: SourceHealth[] = [];
    const settings = meetings.settings();
    const sync = meetings.syncState();
    if (!settings.connectedAt) out.push({ source: "fathom", state: "not_connected", lastSyncAt: sync.lastSuccessAt, detail: "Fathom is not connected" });
    else if (sync.keyState === "invalid") out.push({ source: "fathom", state: "unavailable", lastSyncAt: sync.lastSuccessAt, detail: sync.lastError ?? "Fathom key rejected" });
    else if (sync.failures > 0 || sync.backoffUntil) out.push({ source: "fathom", state: "degraded", lastSyncAt: sync.lastSuccessAt, detail: sync.lastError ?? "Recent sync failures" });
    else out.push({ source: "fathom", state: "ok", lastSyncAt: sync.lastSuccessAt, detail: null });
    const latest = options.latest();
    if (!latest) out.push({ source: "git", state: "unavailable", lastSyncAt: null, detail: "No project scan has run yet" });
    else {
      const bad = [...latest.active, ...latest.other].filter((p) => p.scanStatus === "unavailable" || p.scanStatus === "cached" || !p.exists);
      out.push({ source: "git", state: bad.length ? "degraded" : "ok", lastSyncAt: latest.generatedAt, detail: bad.length ? `${bad.length} project(s) use cached or unavailable repository data` : null });
    }
    const plans = db.prepare("SELECT COUNT(*) AS n FROM delivery_plans").get() as { n: number };
    out.push({ source: "delivery-plan", state: plans.n ? "ok" : "not_connected", lastSyncAt: null, detail: plans.n ? null : "No delivery plans yet" });
    return out;
  }

  function gather(id: string): ReconcileInput {
    const p = findProject(id);
    let goal: string | null = null;
    let milestones: ReconcileInput["milestones"] = [];
    try {
      const state = deliveryRepo(db).read(id);
      goal = state.goal?.goal ?? null;
      const plan = state.plans.find((x) => x.id === state.currentPlanId) ?? state.plans[state.plans.length - 1];
      milestones = (plan?.milestones ?? []).map((m) => ({ id: m.id, position: m.position, title: m.title, outcome: m.outcome, acceptance: m.acceptance, status: m.status, blockedReason: m.blockedReason, dependencies: m.dependencies }));
    } catch { /* project has no delivery record */ }
    let meetingItems: MeetingItem[] = [];
    let meetingList: ReconcileInput["meetings"] = [];
    try {
      meetingItems = meetings.items({ projectId: id, limit: 2000 });
      const last = meetings.lastMeetingFor(id);
      const seen = new Map<string, ReconcileInput["meetings"][number]>();
      for (const m of meetingItems) seen.set(m.recordingId, { recordingId: m.recordingId, title: m.meetingTitle, at: m.meetingAt, headline: null });
      if (last) seen.set(last.recordingId, { recordingId: last.recordingId, title: last.title, at: last.at, headline: last.summary?.headline ?? null });
      meetingList = [...seen.values()].sort((a, b) => b.at.localeCompare(a.at) || a.recordingId.localeCompare(b.recordingId));
    } catch { /* meetings unavailable: keep stored plan */ }
    const act = p?.activity;
    return {
      projectId: id, projectName: projectName(id), goal,
      summary: p ? { recentFocus: p.summary.recentFocus, completed: p.summary.completed, unfinished: p.summary.unfinished } : null,
      commits: act ? act.recentCommitSubjects.map((subject, i) => ({ subject, at: i === 0 ? act.lastCommitAt : null })) : [],
      tasks: (p?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, summary: t.summary, updatedAt: t.updatedAt })),
      meetingItems, meetings: meetingList, milestones, sources: sourceHealth(),
    };
  }

  function freshnessOf(projectId: string, sources: SourceHealth[]): Freshness {
    const rec = store.reconciled(projectId);
    if (!rec) return "never";
    const age = now().getTime() - Date.parse(rec.at);
    let f: Freshness = age > STALE_MS ? "stale" : age > AGING_MS ? "aging" : "fresh";
    if (f === "fresh" && sources.some((s) => s.state === "degraded" || s.state === "unavailable")) f = "aging";
    return f;
  }

  function prioritizeInput(projectId: string, sources: SourceHealth[]): PrioritizeProject {
    const items = store.items(projectId);
    const p = findProject(projectId);
    const hasActivity = !!(p && (p.activity.lastCommitAt || p.tasks.length));
    const readiness = deriveReadiness(items);
    const outcome = store.outcome(projectId);
    const fresh = freshnessOf(projectId, sources);
    const down = sources.filter((s) => s.state === "degraded" || s.state === "unavailable");
    const uncertain = fresh === "stale" || fresh === "never" ? (fresh === "never" ? "This project has never been reconciled." : `Last reconciled ${store.reconciled(projectId)?.at ?? "a long time ago"}; information may be out of date.`)
      : down.length ? `Using stored data; ${down.map((s) => s.source).join(", ")} ${down.length > 1 ? "are" : "is"} not fully available.` : null;
    return {
      projectId, projectName: projectName(projectId), items,
      stage: outcome?.stageOverride ?? deriveStage(items, readiness, hasActivity), readiness, hasOutcome: !!outcome,
      outcomeDraftPending: store.proposals(projectId).some((x) => x.kind === "outcome_draft" && x.status === "pending"), uncertain,
    };
  }

  function compute(sources = sourceHealth()): { inputs: PrioritizeProject[]; byProject: Map<string, ProjectObjectives>; queue: Objective[] } {
    const inputs = projectIds().map((id) => prioritizeInput(id, sources));
    return { inputs, ...prioritizeAll(inputs, now()) };
  }

  /** Records why a recommendation changed; unchanged objectives write nothing. */
  function recordObjectives(byProject: Map<string, ProjectObjectives>, trigger: string): void {
    const at = now().toISOString();
    for (const [projectId, r] of byProject) {
      const o = r.objective;
      if (!o) continue;
      const prev = store.snapshot(projectId);
      if (prev?.objectiveId === o.id) continue;
      const why = o.scoreReasons[0]?.detail ?? "no reason recorded";
      store.addChange({ projectId, kind: "objective_changed", itemId: o.targetItemIds[0] ?? null,
        summary: `Next objective ${prev ? `changed from "${prev.objective}" to` : "set to"} "${o.objective}" because ${why}. Triggered by: ${trigger}`,
        sources: o.evidence.slice(0, 3).map((e) => e.label) }, at);
      store.saveSnapshot({ projectId, objectiveId: o.id, objective: o.objective, score: o.score, reasons: o.scoreReasons, chosenAt: at });
    }
  }

  async function reconcile(projectId?: string): Promise<ReconcileReport[]> {
    const ids = projectId ? [projectId] : projectIds();
    const reports: ReconcileReport[] = [];
    for (const id of ids) {
      const input = gather(id);
      let extra: Awaited<ReturnType<NonNullable<IntelServiceOptions["hook"]>["extraFacts"]>> = [];
      if (options.hook) { try { extra = await options.hook.extraFacts(input); } catch { extra = []; } }
      reports.push(reconcileProject(store, input, now(), extra));
    }
    const { byProject } = compute();
    store.tx(() => recordObjectives(byProject, "reconcile"));
    return reports;
  }
  /** Synchronous variant for hooks that cannot await (meeting onChanged). Core rules are synchronous anyway. */
  function reconcileSync(projectId?: string): ReconcileReport[] {
    const reports = (projectId ? [projectId] : projectIds()).map((id) => reconcileProject(store, gather(id), now()));
    const { byProject } = compute();
    store.tx(() => recordObjectives(byProject, "meeting change"));
    return reports;
  }

  const day = (): string => now().toISOString().slice(0, 10);

  function focus(): FocusState {
    const sources = sourceHealth();
    const { inputs, byProject, queue } = compute(sources);
    const pending = store.pendingProposals();
    const rank: Record<string, number> = { conflict: 0, deadline_change: 1, new_commitment: 2, scope_change: 3, new_requirement: 4, mark_complete: 5, mark_obsolete: 6, outcome_draft: 7, clarification: 8, };
    const decisions = [...pending].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || Number(b.material) - Number(a.material) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const rows: ProjectFocusRow[] = inputs.map((inp): ProjectFocusRow => {
      const items = inp.items;
      const outcome = projectOutcome(store, inp.projectId, items, !!findProject(inp.projectId)?.activity.lastCommitAt);
      const reached = items.map((i) => i.readinessReached).filter((x): x is ReadinessLevel => x !== null);
      const top = READINESS_LEVELS.filter((l) => reached.includes(l)).pop() ?? null;
      const ms = items.filter((i) => i.kind === "milestone" && i.status !== "dropped" && i.status !== "obsolete");
      const next = items.filter((i) => i.kind === "commitment" && (i.status === "open" || i.status === "in_progress") && i.dueDate).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.id.localeCompare(b.id))[0];
      const rec = store.reconciled(inp.projectId);
      return {
        projectId: inp.projectId, projectName: inp.projectName, stage: inp.stage, outcome: outcome?.desiredOutcome ?? null, outcomeBasis: outcome?.basis ?? null,
        objective: byProject.get(inp.projectId)?.objective ?? null, readinessReached: top,
        counts: {
          requirements: items.filter((i) => i.kind === "requirement" && i.status !== "dropped" && i.status !== "obsolete").length,
          milestonesDone: ms.filter((i) => i.status === "done").length, milestonesTotal: ms.length,
          openBlockers: items.filter((i) => i.kind === "blocker" && (i.status === "open" || i.status === "in_progress")).length,
          pendingProposals: pending.filter((x) => x.projectId === inp.projectId).length,
        },
        nextCommitment: next?.dueDate ? { title: next.title, dueDate: next.dueDate } : null,
        freshness: freshnessOf(inp.projectId, sources), lastReconciledAt: rec?.at ?? null,
      };
    }).filter((r) => r.objective || r.counts.requirements || r.counts.milestonesTotal || r.counts.pendingProposals || r.outcome || r.lastReconciledAt)
      .sort((a, b) => (queue.findIndex((o) => o.projectId === a.projectId) + 1 || 9999) - (queue.findIndex((o) => o.projectId === b.projectId) + 1 || 9999) || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId));
    const horizon = new Date(now().getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    const names = new Map(inputs.map((i) => [i.projectId, i.projectName]));
    const all = inputs.flatMap((i) => i.items);
    const recs = store.allReconciled().map((r) => r.at).sort();
    return {
      generatedAt: now().toISOString(), top: queue[0] ?? null, queue, projects: rows, decisions,
      external: {
        blockers: all.filter((i) => i.kind === "blocker" && (i.status === "open" || i.status === "in_progress") && (i.owner === "client" || i.owner === "third_party"))
          .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id))
          .map((i) => ({ itemId: i.id, text: i.title, owner: i.owner, projectId: i.projectId, projectName: names.get(i.projectId) ?? i.projectId })),
        commitments: all.filter((i) => i.kind === "commitment" && (i.status === "open" || i.status === "in_progress") && i.dueDate && i.dueDate <= horizon)
          .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.id.localeCompare(b.id))
          .map((i) => ({ itemId: i.id, projectId: i.projectId, projectName: names.get(i.projectId) ?? i.projectId, title: i.title, dueDate: i.dueDate, owner: i.owner })),
      },
      recentChanges: store.recentChanges(20), sources, lastReconciledAt: recs[recs.length - 1] ?? null,
    };
  }

  function projectIntel(id: string): ProjectIntel {
    if (!knownProject(id)) throw new IntelError("not-found", "Unknown project");
    const sources = sourceHealth();
    const inp = prioritizeInput(id, sources);
    const objectives = prioritizeAll([inp], now()).byProject.get(id) ?? { objective: null, others: [] };
    const outcome: ProjectOutcome | null = projectOutcome(store, id, inp.items, !!findProject(id)?.activity.lastCommitAt);
    return {
      projectId: id, projectName: inp.projectName, outcome, items: inp.items, objective: objectives.objective, otherActions: objectives.others,
      proposals: store.proposals(id).sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
      history: store.changes(id, 50), gaps: computeGaps(inp), freshness: freshnessOf(id, sources), lastReconciledAt: store.reconciled(id)?.at ?? null,
    };
  }

  // ---- human control -------------------------------------------------------------------------------------

  const humanProv = (label: string) => ({ sourceKind: "human" as const, sourceId: null, label, quote: null, observedAt: now().toISOString(), confidence: "high" as const, link: null });
  const refresh = (projectId: string, trigger: string): void => { store.tx(() => recordObjectives(compute().byProject, trigger)); void projectId; };

  function putOutcome(projectId: string, v: { desiredOutcome: string; acceptanceCriteria: string[]; stage?: DeliveryStage; lock?: boolean }): ProjectIntel {
    if (!knownProject(projectId)) throw new IntelError("not-found", "Unknown project");
    const at = now().toISOString();
    const prev = store.outcome(projectId);
    store.tx(() => {
      store.saveOutcome({
        projectId, desiredOutcome: v.desiredOutcome, acceptanceCriteria: v.acceptanceCriteria,
        stageOverride: v.stage ?? prev?.stageOverride ?? null, basis: "confirmed", locked: v.lock ?? prev?.locked ?? false,
        provenance: [...(prev?.provenance ?? []), humanProv("Edited by you")].slice(-10), updatedAt: at,
      });
      store.addChange({ projectId, kind: "human_edit", summary: `Delivery outcome ${prev ? "edited" : "set"}: ${v.desiredOutcome.slice(0, 120)}`, sources: ["human"] }, at);
    });
    refresh(projectId, "outcome edit");
    return projectIntel(projectId);
  }

  function addItem(projectId: string, v: { kind: ItemKind; title: string; detail?: string | null; dueDate?: string | null; owner?: Owner; acceptance?: string[]; dependsOn?: string[] }): ProjectIntel {
    if (!knownProject(projectId)) throw new IntelError("not-found", "Unknown project");
    const id = itemId(projectId, v.kind, v.title);
    if (store.item(id)) throw new IntelError("conflict", "An equivalent item already exists");
    for (const d of v.dependsOn ?? []) if (store.item(d)?.projectId !== projectId) throw new IntelError("invalid", "Unknown dependency");
    const at = now().toISOString();
    const work = v.kind === "requirement" || v.kind === "milestone";
    store.tx(() => {
      store.insertItem({
        id, projectId, kind: v.kind, title: v.title, detail: v.detail ?? null, basis: "confirmed", status: v.kind === "decision" || v.kind === "exclusion" ? "done" : "open",
        evidenceState: work || v.kind === "commitment" ? "not_implemented" : "unknown", readinessTarget: work ? "usable_by_client" : null, readinessReached: null,
        owner: v.owner ?? (v.kind === "blocker" ? "client" : "me"), dueDate: v.dueDate ?? null, acceptance: v.acceptance ?? [], dependsOn: v.dependsOn ?? [], locked: false,
        provenance: [humanProv("Added by you")], lastSupportedAt: at, createdAt: at, updatedAt: at,
      }, v.title);
      store.addChange({ projectId, kind: "human_edit", summary: `Added ${v.kind}: ${v.title}`, itemId: id, sources: ["human"] }, at);
    });
    refresh(projectId, "item added");
    return projectIntel(projectId);
  }

  function patchItem(id: string, v: ItemFields): ProjectIntel {
    const item = store.item(id);
    if (!item) throw new IntelError("not-found", "Unknown item");
    const at = now().toISOString();
    const next: IntelItem = { ...item };
    const touched: string[] = [];
    const set = <K extends keyof IntelItem>(k: K, val: IntelItem[K]): void => { if (JSON.stringify(next[k]) !== JSON.stringify(val)) { next[k] = val; touched.push(k); } };
    if (v.title !== undefined) set("title", v.title);
    if (v.detail !== undefined) set("detail", v.detail);
    if (v.status !== undefined) set("status", v.status);
    if (v.evidenceState !== undefined) set("evidenceState", v.evidenceState);
    if (v.owner !== undefined) set("owner", v.owner);
    if (v.dueDate !== undefined) set("dueDate", v.dueDate);
    if (v.acceptance !== undefined) set("acceptance", v.acceptance);
    if (v.locked !== undefined) set("locked", v.locked);
    if (v.readinessReached !== undefined) set("readinessReached", v.readinessReached);
    if (v.confirm || touched.length) set("basis", "confirmed" as Basis);
    if (!touched.length) return projectIntel(item.projectId);
    next.updatedAt = at;
    store.tx(() => {
      store.updateItem(next);
      store.addChange({ projectId: item.projectId, kind: "human_edit", summary: `Edited "${item.title}": ${touched.join(", ")}`, itemId: id, sources: ["human"] }, at);
      if (next.status === "done" && item.status !== "done") store.addChange({ projectId: item.projectId, kind: "item_completed", summary: `"${item.title}" marked done by you (evidence: ${next.evidenceState})`, itemId: id, sources: ["human"] }, at);
    });
    refresh(item.projectId, "human edit");
    return projectIntel(item.projectId);
  }

  const FIELD_CHECK: Record<string, (v: unknown) => boolean> = {
    status: (v) => ITEM_STATUSES.includes(v as ItemStatus), evidenceState: (v) => EVIDENCE_STATES.includes(v as EvidenceState),
    owner: (v) => OWNERS.includes(v as Owner), dueDate: (v) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)),
    basis: (v) => v === "confirmed" || v === "inferred", locked: (v) => typeof v === "boolean", title: (v) => typeof v === "string" && v.length > 0 && v.length <= 300,
    detail: (v) => v === null || typeof v === "string", acceptance: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  };

  function resolveProposal(id: string, accept: boolean, note: string | null): FocusState {
    const p = store.proposal(id);
    if (!p) throw new IntelError("not-found", "Unknown proposal");
    if (p.status !== "pending") throw new IntelError("conflict", "Proposal already resolved");
    const at = now().toISOString();
    store.tx(() => {
      if (accept) apply(p, at);
      else if (p.kind === "new_commitment" && p.itemId) {
        const it = store.item(p.itemId);
        if (it && it.basis === "inferred" && !it.locked) store.updateItem({ ...it, status: "dropped", updatedAt: at });
      }
      store.resolveProposal(id, accept ? "accepted" : "rejected", note, at);
      store.addChange({ projectId: p.projectId, kind: "proposal_resolved", summary: `${accept ? "Accepted" : "Rejected"}: ${p.summary}${note ? ` (${note})` : ""}`, itemId: p.itemId, sources: ["human"] }, at);
    });
    refresh(p.projectId, `proposal ${accept ? "accepted" : "rejected"}`);
    return focus();
  }

  function apply(p: Proposal, at: string): void {
    const patch = p.patch;
    const op = patch.op;
    if (op === "set_outcome" && typeof patch.desiredOutcome === "string" && Array.isArray(patch.acceptanceCriteria)) {
      const prev = store.outcome(p.projectId);
      store.saveOutcome({ projectId: p.projectId, desiredOutcome: patch.desiredOutcome, acceptanceCriteria: patch.acceptanceCriteria.filter((x): x is string => typeof x === "string"),
        stageOverride: prev?.stageOverride ?? null, basis: "confirmed", locked: prev?.locked ?? false, provenance: [...p.provenance, humanProv("Accepted by you")].slice(-10), updatedAt: at });
    } else if (op === "create_item" && p.itemId && patch.item && typeof patch.item === "object") {
      const src = patch.item as Record<string, unknown>;
      if (store.item(p.itemId)) return;
      const kind = ITEM_KINDS.includes(src.kind as ItemKind) ? (src.kind as ItemKind) : "requirement";
      store.insertItem({
        id: p.itemId, projectId: p.projectId, kind, title: String(src.title ?? p.summary), detail: typeof src.detail === "string" ? src.detail : null, basis: "confirmed",
        status: "open", evidenceState: "not_implemented", readinessTarget: "usable_by_client", readinessReached: null, owner: OWNERS.includes(src.owner as Owner) ? (src.owner as Owner) : "unknown",
        dueDate: typeof src.dueDate === "string" ? src.dueDate : null, acceptance: Array.isArray(src.acceptance) ? src.acceptance.filter((x): x is string => typeof x === "string") : [],
        dependsOn: [], locked: false, provenance: [...p.provenance, humanProv("Accepted by you")], lastSupportedAt: at, createdAt: at, updatedAt: at,
      }, String(src.title ?? p.summary));
    } else if (op === "update_item" && typeof patch.itemId === "string" && patch.fields && typeof patch.fields === "object") {
      const item = store.item(patch.itemId);
      if (!item) return;
      const next: Record<string, unknown> = { ...item };
      for (const [k, v] of Object.entries(patch.fields as Record<string, unknown>)) if (FIELD_CHECK[k]?.(v)) next[k] = v;
      store.updateItem({ ...(next as IntelItem), basis: "confirmed", updatedAt: at });
      if ((patch.fields as Record<string, unknown>).status === "done") store.addChange({ projectId: p.projectId, kind: "item_completed", summary: `"${item.title}" marked done by you`, itemId: item.id, sources: ["human"] }, at);
    }
  }

  function brief(objectiveId: string): string | null {
    const { queue, byProject } = compute();
    const all = [...queue, ...[...byProject.values()].flatMap((r) => r.others)];
    return all.find((o) => o.id === objectiveId)?.brief ?? null;
  }
  function objectiveExists(objectiveId: string): boolean {
    const { queue, byProject } = compute();
    return [...queue, ...[...byProject.values()].flatMap((r) => r.others)].some((o) => o.id === objectiveId);
  }

  /** Periodic freshness check. Only the server entry starts it (never tests). */
  function startScheduler(): void {
    if (timer) return;
    timer = setInterval(() => { void reconcile().catch(() => undefined); }, options.intervalMs ?? 15 * 60_000);
    timer.unref();
  }
  function close(): void { if (timer) { clearInterval(timer); timer = null; } }

  return { store, reconcile, reconcileSync, focus, projectIntel, putOutcome, addItem, patchItem, resolveProposal, brief, objectiveExists, knownProject, startScheduler, close, sourceHealth, gather };
}
export type IntelService = ReturnType<typeof intelService>;
export type { ChangeEntry };
