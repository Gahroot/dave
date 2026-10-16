import type {
  Blocker, DeliveryProgress, DeliveryStage, DeliveryStep, Freshness, IntelItem, ItemKind, ItemStatus, Move, Objective, Proposal, ProjectFocusRow, ReadinessLevel, SourceHealth,
} from "../intel/types.ts";
import { DELIVERY_STEPS, READINESS_LEVELS, VISIBLE_MOVES } from "../intel/types.ts";

/** Pure labels, grouping and sorting for the Focus home. No React, no clock: callers pass `now`. */

const DAY = 86_400_000;

export const STAGE_LABEL: Readonly<Record<DeliveryStage, string>> = {
  discovery: "Discovery", building: "Building", integration: "Integration", validation: "Validation",
  deployment: "Deployment", onboarding: "Onboarding", accepted: "Accepted",
};

export const READINESS_QUESTION: Readonly<Record<ReadinessLevel, string>> = {
  code_complete: "Is the code finished?",
  deployed: "Is it running somewhere real?",
  usable_by_client: "Can the client actually use it?",
  client_accepted: "Has the client accepted it?",
};

export const ITEM_KIND_LABEL: Readonly<Record<ItemKind, string>> = {
  requirement: "Requirement", milestone: "Milestone", commitment: "Commitment", blocker: "Blocker", decision: "Decision", exclusion: "Out of scope",
};

export const ITEM_STATUS_LABEL: Readonly<Record<ItemStatus, string>> = {
  open: "Open", in_progress: "In progress", done: "Done", dropped: "Dropped", obsolete: "Obsolete",
};

export const OWNER_LABEL = { me: "You", client: "Client", third_party: "Third party", unknown: "Unknown owner" } as const;

/** Each level is shown on its own; reaching a higher level does not claim the lower ones were separately evidenced. */
export function readinessCells(reached: ReadinessLevel | null): { level: ReadinessLevel; reached: boolean }[] {
  const top = reached ? READINESS_LEVELS.indexOf(reached) : -1;
  return READINESS_LEVELS.map((level, i) => ({ level, reached: i <= top }));
}

/** Word for the readiness summary of a row: never "done". */
export function readinessSummary(reached: ReadinessLevel | null): string {
  if (!reached) return "No readiness evidenced yet";
  return `Evidenced up to: ${reached.replace(/_/g, " ")}`;
}

function age(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, now - t);
}

/** "3 days ago", never implying current when unknown. */
export function agoLabel(iso: string | null | undefined, now: number): string {
  const a = age(iso, now);
  if (a === null) return "never";
  if (a < 60_000) return "just now";
  if (a < 3_600_000) return `${Math.round(a / 60_000)} min ago`;
  if (a < DAY) return `${Math.round(a / 3_600_000)} h ago`;
  const days = Math.round(a / DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function freshnessText(freshness: Freshness, lastAt: string | null | undefined, now: number): string {
  if (freshness === "never" || !lastAt) return "Never reconciled; nothing here is confirmed current";
  const when = agoLabel(lastAt, now);
  if (freshness === "fresh") return `Reconciled ${when}`;
  if (freshness === "aging") return `Reconciled ${when}; may have changed since`;
  return `Reconciled ${when}; treat as out of date`;
}

/** Evidence freshness for a single provenance or item; thresholds match "aging" at 7d and "stale" at 21d. */
export function evidenceFreshness(observedAt: string | null | undefined, now: number): Freshness {
  const a = age(observedAt, now);
  if (a === null) return "never";
  return a < 7 * DAY ? "fresh" : a < 21 * DAY ? "aging" : "stale";
}

/** Date-only ISO (YYYY-MM-DD) compared in UTC days. */
export function dueState(dueDate: string | null, now: number): { kind: "none" | "overdue" | "today" | "soon" | "later"; label: string } {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return { kind: "none", label: "No due date" };
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due)) return { kind: "none", label: "No due date" };
  const today = Math.floor(now / DAY) * DAY;
  const days = Math.round((due - today) / DAY);
  if (days < 0) return { kind: "overdue", label: `Overdue by ${-days} ${-days === 1 ? "day" : "days"} (${dueDate.slice(0, 10)})` };
  if (days === 0) return { kind: "today", label: "Due today" };
  if (days <= 7) return { kind: "soon", label: `Due in ${days} ${days === 1 ? "day" : "days"} (${dueDate.slice(0, 10)})` };
  return { kind: "later", label: `Due ${dueDate.slice(0, 10)}` };
}

/** Only in-app hash links are followed; anything else from a source is shown as text. */
export function safeLink(link: string | null | undefined): string | null {
  return link && /^#(focus|queue|projects|meetings|issues|connections)(\?[A-Za-z0-9_=&%.-]{0,300})?$/.test(link) ? link : null;
}

const FRESHNESS_RANK: Readonly<Record<Freshness, number>> = { stale: 0, never: 1, aging: 2, fresh: 3 };

/** Focus queue order: the server ranking is kept (objective score); projects without an objective sink, stale first among those. */
export function sortProjectRows(rows: readonly ProjectFocusRow[]): ProjectFocusRow[] {
  return [...rows].sort((a, b) =>
    (b.objective?.score ?? Number.NEGATIVE_INFINITY) - (a.objective?.score ?? Number.NEGATIVE_INFINITY) ||
    FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness] ||
    a.projectName.localeCompare(b.projectName));
}

/** Material decisions first, then oldest first so nothing waits silently. */
export function sortDecisions(proposals: readonly Proposal[]): Proposal[] {
  return proposals.filter(p => p.status === "pending").sort((a, b) =>
    Number(b.material) - Number(a.material) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function proposalOrigin(p: Proposal): "confirmed" | "inferred" {
  return p.provenance.length > 0 && p.provenance.every(x => x.sourceKind === "human") ? "confirmed" : "inferred";
}

const KIND_ORDER: readonly ItemKind[] = ["milestone", "requirement", "commitment", "blocker", "decision", "exclusion"];
const STATUS_ORDER: Readonly<Record<ItemStatus, number>> = { in_progress: 0, open: 1, done: 2, dropped: 3, obsolete: 4 };

export function sortItems(items: readonly IntelItem[]): IntelItem[] {
  return [...items].sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function groupItemsByKind(items: readonly IntelItem[]): { kind: ItemKind; items: IntelItem[] }[] {
  return KIND_ORDER.map(kind => ({ kind, items: sortItems(items.filter(i => i.kind === kind)) })).filter(g => g.items.length > 0);
}

/** Meeting-derived commitments the project owner made, not yet finished. */
export function meetingCommitments(items: readonly IntelItem[]): IntelItem[] {
  return sortItems(items.filter(i => i.kind === "commitment" && i.status !== "done" && i.status !== "dropped" && i.status !== "obsolete" &&
    i.provenance.some(p => p.sourceKind === "meeting")));
}

export function openBlockers(items: readonly IntelItem[]): IntelItem[] {
  return sortItems(items.filter(i => (i.kind === "blocker" || i.evidenceState === "blocked") && i.status !== "done" && i.status !== "dropped" && i.status !== "obsolete"));
}

export function blockerOwnerText(b: Blocker): string {
  return `${OWNER_LABEL[b.owner]}: ${b.text}`;
}

/** The only reason to hide the brief: a human step. */
export function briefMode(o: Objective): "copy" | "human" | "none" {
  if (o.humanOnly) return "human";
  return o.brief && o.brief.trim() ? "copy" : "none";
}

export const BRIEF_NOTICE = "DAVE only gives you this text. Paste it into EZcoder yourself; nothing is started from here.";

/** Source strip: stale or degraded data must be visible. A sync older than 24h is flagged even when the source says ok. */
export function sourceWarning(s: SourceHealth, now: number): string | null {
  if (s.state === "not_connected") return null;
  if (s.state === "unavailable") return s.detail ?? "Source unavailable; recommendations may be out of date.";
  if (s.state === "degraded") return s.detail ?? "Source degraded; some evidence may be missing.";
  const a = age(s.lastSyncAt, now);
  if (a === null) return "Never synced; nothing from this source is known.";
  return a > DAY ? `Last sync ${agoLabel(s.lastSyncAt, now)}; may be out of date.` : null;
}

export const SOURCE_NAME: Readonly<Record<SourceHealth["source"], string>> = { fathom: "Fathom meetings", git: "Git history", "delivery-plan": "Delivery plans" };

export function sourcesWithWarnings(sources: readonly SourceHealth[], now: number): { source: SourceHealth; warning: string | null }[] {
  return [...sources].sort((a, b) => a.source.localeCompare(b.source)).map(source => ({ source, warning: sourceWarning(source, now) }));
}

export function countLine(c: ProjectFocusRow["counts"]): string {
  const parts = [`${c.requirements} ${c.requirements === 1 ? "requirement" : "requirements"}`, `${c.milestonesDone} of ${c.milestonesTotal} milestones done`];
  if (c.openBlockers) parts.push(`${c.openBlockers} ${c.openBlockers === 1 ? "blocker" : "blockers"}`);
  if (c.pendingProposals) parts.push(`${c.pendingProposals} awaiting you`);
  return parts.join(" · ");
}

export function isFirstRun(state: { top: unknown; projects: readonly ProjectFocusRow[]; lastReconciledAt: string | null }): boolean {
  return !state.top && state.lastReconciledAt === null && state.projects.every(p => p.outcome === null);
}

/** Unknown dates sort last; confirmed edit helpers keep acceptance lists tidy. */
export function parseLines(text: string, max = 20): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, max);
}

/** What reaching each delivery step asks of you, phrased as the next thing to do. */
export const STEP_GOAL: Readonly<Record<DeliveryStep, string>> = {
  production_ready: "Verify the finish line",
  live: "Go live",
  using: "Get the client using it",
  signed_off: "Get sign-off",
};

/** Home order: confirmed projects in delivery, most behind first. Unconfirmed and delivered projects sit in their own groups. */
export function homeGroups(rows: readonly ProjectFocusRow[]): { ranked: ProjectFocusRow[]; setup: ProjectFocusRow[]; delivered: ProjectFocusRow[] } {
  const byName = (a: ProjectFocusRow, b: ProjectFocusRow) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId);
  const ranked = rows.filter(r => r.delivery.confirmed && !r.delivery.delivered).sort((a, b) =>
    (b.delivery.behind?.score ?? 0) - (a.delivery.behind?.score ?? 0) ||
    a.delivery.percentDone - b.delivery.percentDone || byName(a, b));
  return {
    ranked,
    setup: rows.filter(r => !r.delivery.confirmed).sort(byName),
    delivered: rows.filter(r => r.delivery.confirmed && r.delivery.delivered).sort(byName),
  };
}

/** "Step 2 of 4: Go live". */
export function stepLabel(p: DeliveryProgress): string {
  if (!p.confirmed) return "Finish line not confirmed";
  if (p.delivered || !p.currentStep) return "Delivered: signed off";
  return `Step ${p.stepNumber} of ${DELIVERY_STEPS.length}: ${STEP_GOAL[p.currentStep]}`;
}

/** Each step on its own; reaching a later step never claims an earlier one. */
export function stepCells(p: DeliveryProgress): { step: DeliveryStep; reached: boolean; current: boolean }[] {
  return DELIVERY_STEPS.map(step => ({ step, reached: p.steps[step], current: p.currentStep === step }));
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The score's parts, so the number is never shown alone. */
export function behindLine(p: DeliveryProgress): string {
  const b = p.behind;
  if (!b) return "Not scored until the finish line is confirmed";
  const schedule = b.schedule === null ? "No target date" : `Behind schedule ${b.schedule}`;
  return `${schedule} · Distance ${b.distance} · Stalled ${b.stalled} (${days(b.stalledDays)})`;
}

/** "5 of 9 verified · 49% done". */
export function progressLine(p: DeliveryProgress): string {
  const verified = p.finishLineItems === 0 ? "No finish-line items yet" : `${p.verifiedItems} of ${p.finishLineItems} verified`;
  return `${verified} · ${p.percentDone}% done`;
}

/** Score floors for the colour bands. The colour only repeats the number, which is always shown with its parts. */
export const BEHIND_BAND_FLOORS = { far: 70, behind: 40 } as const;

/** Colour and word for a behind score: red far behind, amber behind, blue on pace. */
export function behindBand(score: number): { tone: "red" | "amber" | "blue"; label: string } {
  if (score >= BEHIND_BAND_FLOORS.far) return { tone: "red", label: "Far behind" };
  if (score >= BEHIND_BAND_FLOORS.behind) return { tone: "amber", label: "Behind" };
  return { tone: "blue", label: "On pace" };
}

/** Decisions grouped by project in their existing order, so each project name is read once. */
export function groupDecisions<T extends Pick<Proposal, "projectId" | "projectName">>(decisions: readonly T[]): { projectId: string; projectName: string; decisions: T[] }[] {
  const groups = new Map<string, { projectId: string; projectName: string; decisions: T[] }>();
  for (const d of decisions) {
    const group = groups.get(d.projectId) ?? { projectId: d.projectId, projectName: d.projectName, decisions: [] };
    group.decisions.push(d);
    groups.set(d.projectId, group);
  }
  return [...groups.values()];
}

/** Today at a glance. Real counts only, each one repeated further down the page. */
export function homePulse(state: { projects: readonly ProjectFocusRow[]; decisions: readonly unknown[] }): { inDelivery: number; overdue: number; decisions: number; waitingOnClient: number } {
  const { ranked } = homeGroups(state.projects);
  return {
    inDelivery: ranked.length,
    overdue: ranked.filter(r => r.delivery.overdue).length,
    decisions: state.decisions.length,
    waitingOnClient: ranked.filter(r => r.delivery.waitingOnClient).length,
  };
}

/** At most VISIBLE_MOVES moves up front; the rest go behind a disclosure. */
export function visibleMoves<T extends Move>(moves: readonly T[]): { shown: T[]; more: T[] } {
  return { shown: moves.slice(0, VISIBLE_MOVES), more: moves.slice(VISIBLE_MOVES) };
}
