import { isOpen, laneOf } from "../intel/scope.ts";
import { DELIVERY_STEPS, type DeliveryProgress, type DeliveryStep, type EvidenceState, type IntelItem } from "../intel/types.ts";
import type { ItemDelta, MissingPiece, ProgressReport, WorkEvent, WorkOutcome } from "./types.ts";

export type AssessInput = {
  event: WorkEvent;
  projectName: string;
  before: IntelItem[];
  after: IntelItem[];
  /** Defaults to the event's outcome. */
  outcome?: WorkOutcome;
  /** Delivery progress after the reconcile, for unreached steps; null when unknown. */
  plan: Pick<DeliveryProgress, "steps"> | null;
  nextBefore: { id: string; title: string } | null;
  nextAfter: { id: string; title: string } | null;
};

const RANK: Record<EvidenceState, number> = { not_implemented: 0, unknown: 0, blocked: 0, unverified: 1, implementation_observed: 1, verified: 2 };
const rank = (i: IntelItem): number => Math.max(RANK[i.evidenceState], i.status === "done" ? 1 : 0);
const STEP_LABEL: Record<DeliveryStep, string> = { production_ready: "Production ready", live: "Live for the client", using: "Client is using it", signed_off: "Client signed off" };
const SOURCE_LEAD = { ezcoder: "EZ Coder finished", git: "New commit", github: "Pull request merged" } as const;

const isWork = (i: IntelItem): boolean => (i.kind === "requirement" || i.kind === "milestone") && i.status !== "dropped" && i.status !== "obsolete";
const byTitle = (a: { title: string; itemId: string | null }, b: { title: string; itemId: string | null }): number =>
  a.title.localeCompare(b.title) || (a.itemId ?? "").localeCompare(b.itemId ?? "");
const quoted = (xs: string[]): string => (xs.length <= 2 ? xs.map((x) => `"${x}"`).join(" and ") : `"${xs[0]}", "${xs[1]}" and ${xs.length - 2} more`);

/** Pure: what one work event moved, and what still stands between the project and its finish line. */
export function assessProgress(input: AssessInput): ProgressReport {
  const { event } = input;
  const outcome = input.outcome ?? event.outcome;
  const before = new Map(input.before.map((i) => [i.id, i]));
  const linked = event.itemIds;
  // One reconcile can cover several events of a project, so the before/after delta is shared. Only credit this event
  // with items it is linked to, or whose code evidence it supplied (reconcile records work evidence as `work:<eventId>`).
  const evidenceRef = `work:${event.id}`;
  const fromThisEvent = (a: IntelItem): boolean => linked.includes(a.id) || a.provenance.some((p) => p.sourceId === evidenceRef);
  const advanced: ItemDelta[] = input.after
    .flatMap((a): ItemDelta[] => {
      const b = before.get(a.id);
      if (!b || rank(a) <= rank(b) || !fromThisEvent(a)) return [];
      return [{ itemId: a.id, title: a.title, from: { status: b.status, evidenceState: b.evidenceState }, to: { status: a.status, evidenceState: a.evidenceState } }];
    })
    .sort(byTitle);
  const moved = new Set(advanced.map((d) => d.itemId));

  const failed = outcome === "failed" || outcome === "aborted";
  const verdict: ProgressReport["verdict"] = failed ? "failed"
    : event.link === "none" && !linked.length ? "no_match"
    : linked.length ? (linked.every((id) => moved.has(id)) ? "moved" : "partial")
    : advanced.length ? "moved" : "partial";

  const finish = input.after.filter((i) => isWork(i) && laneOf(i).lane === "finish_line");
  const stillMissing: MissingPiece[] = [];
  for (const i of [...finish].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))) {
    if (i.evidenceState === "verified") continue;
    const why = i.evidenceState === "implementation_observed" ? "Looks implemented, but nobody has verified it yet"
      : i.evidenceState === "unverified" ? "Reported done, not verified yet" : "Not built yet";
    stillMissing.push({ itemId: i.id, title: i.title, state: i.evidenceState, why });
    for (const check of i.acceptance) stillMissing.push({ itemId: i.id, title: check, state: i.evidenceState, why: `Acceptance check for "${i.title}" is not verified yet` });
  }
  if (input.plan) {
    for (const s of DELIVERY_STEPS) if (!input.plan.steps[s]) stillMissing.push({ itemId: null, title: STEP_LABEL[s], state: "step", why: "Delivery step not reached yet" });
  }
  for (const b of input.after.filter((i) => i.kind === "blocker" && isOpen(i)).sort((a, c) => a.title.localeCompare(c.title) || a.id.localeCompare(c.id))) {
    stillMissing.push({ itemId: b.id, title: b.title, state: b.evidenceState, why: "Open blocker" });
  }

  const verified = finish.filter((i) => i.evidenceState === "verified").length;
  const observed = finish.filter((i) => i.evidenceState !== "verified" && rank(i) >= 1).length;
  const total = finish.length;

  const lead = event.source === "ezcoder" && failed ? `EZ Coder run ${outcome}` : SOURCE_LEAD[event.source];
  const names = advanced.map((d) => d.title);
  const headline = verdict === "failed" ? `${lead}: "${event.title}". Nothing was marked as done.`
    : verdict === "no_match" ? `${lead}: "${event.title}" did not match anything on the plan.`
    : names.length ? `${lead}: ${quoted(names)} now ${names.length === 1 ? "looks" : "look"} implemented (not verified).`
    : `${lead}: "${event.title}" is linked to the plan, but nothing new looks implemented yet.`;

  return {
    eventId: event.id, projectId: event.projectId, projectName: input.projectName, at: event.at, observedAt: event.observedAt, headline, verdict, advanced, stillMissing,
    finishLine: { verified, observed, total, percentDone: total ? Math.round((verified / total) * 100) : 0 },
    nextBefore: input.nextBefore, nextAfter: input.nextAfter, source: event.source, link: event.link,
  };
}
