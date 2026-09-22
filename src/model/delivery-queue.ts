import type { DeliveryState } from "./delivery-schema.ts";
import type { CoordinationState } from "./delivery-coordination.ts";
import { nextDeliveryStep, type NextStep, type NextStepKind } from "./delivery-next-step.ts";


/** How many projects can be "on the go" at once. Capacity comes from finishing, not starting. */
export const WIP_LIMIT = 3;

/** Silence longer than this from a coding tool is a dead run, not progress. */
export const STALE_HANDOFF_DAYS = 2;
const DAY_MS = 86_400_000;

export type QueueEntry = {
  projectId: string; projectName: string; state: "active" | "paused"; startedAt: string;
  step: NextStep;
};

/**
 * Ordered by who is idle because of you, not by what changed most recently. Everything
 * above `send` is work only you can unstick; everything below is yours to do at leisure.
 */
const RANK: Record<NextStepKind, number> = {
  decide: 1,  // A retry loop is burning time and only a scope decision ends it.
  done: 2,    // The finish line. One review away from delivering.
  review: 3,  // Your coding tool is idle waiting on your judgement.
  unblock: 4, // A person outside the work is blocking; longest lead time, chase early.
  stalled: 5, // Sent off and gone quiet. Looks like progress, is not.
  send: 6,    // You can start work right now.
  setup: 7, scope: 7, plan: 7, // Thinking work, best batched.
  waiting: 8, // Nothing to do but wait for an answer.
};
export const stepRank = (kind: NextStepKind): number => RANK[kind];

/** Whole days of silence, or null when the send time was never recorded. */
export function handoffAgeDays(createdAt: string | null, now: Date): number | null {
  if (!createdAt) return null;
  const sent = Date.parse(createdAt);
  if (!Number.isFinite(sent)) return null;
  return Math.floor((now.getTime() - sent) / DAY_MS);
}

/**
 * Turns "still waiting" into "this died" once the silence is long enough. Both ways out
 * end the wait: send it again, or take it back. Nothing here calls a model.
 */
export function withStaleHandoff(step: NextStep, coordination: CoordinationState, now: Date): NextStep {
  if (step.kind !== "waiting" || !step.milestoneId) return step;
  const handoff = coordination.handoffs.find(h => h.milestoneId === step.milestoneId);
  const days = handoffAgeDays(handoff?.createdAt ?? null, now);
  if (days === null || days < STALE_HANDOFF_DAYS) return step;
  return { kind: "stalled", milestoneId: step.milestoneId,
    headline: `Sent ${days} days ago, nothing came back`,
    why: "Your coding tool has been silent long enough that the run has probably died. Send it again, or take it back and decide what to do with it." };
}

export type QueueInput = { projectId: string; projectName: string; state: "active" | "paused"; startedAt: string }
  & ({ delivery: DeliveryState; coordination: CoordinationState; unreadable?: undefined } | { unreadable: true });

/** Shown in place of a step when saved delivery data cannot be read; never silently dropped. */
const UNREADABLE: NextStep = { kind: "setup", headline: "This one's saved details won't open", why: "Its delivery information could not be read, so there is nothing reliable to suggest. Open the project to set it out again." };

export function buildDeliveryQueue(projects: QueueInput[], now = new Date()): QueueEntry[] {
  return projects
    .map(p => ({ projectId: p.projectId, projectName: p.projectName, state: p.state, startedAt: p.startedAt, step: p.unreadable ? UNREADABLE : withStaleHandoff(nextDeliveryStep(p.delivery, p.coordination), p.coordination, now) }))
    // Paused engagements keep their computed step but never compete for attention.
    .sort((a, b) => Number(a.state === "paused") - Number(b.state === "paused")
      || stepRank(a.step.kind) - stepRank(b.step.kind)
      || a.startedAt.localeCompare(b.startedAt)
      || a.projectId.localeCompare(b.projectId));
}
