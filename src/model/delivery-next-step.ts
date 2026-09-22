import type { DeliveryState } from "./delivery-schema.ts";
import type { CoordinationState } from "./delivery-coordination.ts";
import { deriveDeliveryProgress, reportFailures } from "./delivery-progress.ts";

export type NextStepKind = "setup" | "scope" | "plan" | "send" | "waiting" | "stalled" | "review" | "unblock" | "decide" | "done";
export type NextStep = {
  kind: NextStepKind;
  /** One plain sentence: what to do right now. */
  headline: string;
  /** One plain sentence: why this and not something else. */
  why: string;
  milestoneId?: string;
};

/**
 * Single source of truth for "what do I do today". Every state resolves to exactly one
 * action so the UI never has to make the user diagnose the situation themselves.
 */
export function nextDeliveryStep(state: DeliveryState, coordination: CoordinationState): NextStep {
  const progress = deriveDeliveryProgress(state, coordination);
  if (!state.goal) return { kind: "setup", headline: "Say what this project is for", why: "Nothing else can be worked out until the goal is written down." };
  if (!coordination.contract || progress.stale) return { kind: "scope", headline: "Write down what 'finished' means", why: progress.stale ? "The goal changed, so the old finish line no longer applies." : "Without a finish line the work never stops growing." };
  if (progress.uncovered.length) return { kind: "scope", headline: "Say which piece of work proves each promise", why: `Nothing currently proves: ${progress.uncovered.map(c => c.text).join("; ")}.` };
  if (!state.plans.find(p => p.id === state.currentPlanId)) return { kind: "plan", headline: "Get the work broken into pieces", why: "Copy the planning prompt into your coding tool, then paste its answer back." };
  const item = progress.next;
  /** Same wording whether or not a piece of work is currently selected: short who, full what. */
  const chase = (position?: number, title?: string): NextStep => {
    const blocker = (position === undefined ? undefined : progress.unresolved.find(p => p.milestones.includes(position))) ?? progress.unresolved[0];
    if (!blocker) return { kind: "unblock", headline: "Clear the blocker", why: "Every remaining piece is waiting on something outside the code." };
    return { kind: "unblock", headline: `Chase ${blocker.owner}`, why: `${blocker.text}${title ? ` ${title} cannot start until this is sorted.` : ""}` };
  };
  if (!item) {
    if (progress.readyForReview) return { kind: "done", headline: "Everything in scope is done", why: "Get the pilot reviewed by a person; there is deliberately no more work queued." };
    return chase();
  }
  const title = item.milestone.title;
  if (item.prerequisites.length) return { ...chase(item.milestone.position, title), milestoneId: item.milestone.id };
  if (item.status === "needs-review") {
    const failures = reportFailures(item.report!.report);
    return { kind: "review", headline: `Check the work on ${title}`, why: failures.length ? `It came back with problems: ${failures.join("; ")}.` : "Read what came back, then accept it or send it back.", milestoneId: item.milestone.id };
  }
  if (item.status === "handed-off") return { kind: "waiting", headline: `Paste back the result for ${title}`, why: "This is already with your coding tool; nothing moves until its answer comes back.", milestoneId: item.milestone.id };
  /** Deliberately no fourth attempt: the three ways out all end the loop. */
  if (item.status === "contested") return { kind: "decide", headline: `${item.returns} tries on ${title} — decide, don't retry`, why: `You sent it back for: ${item.returnReasons.join("; ")}. Sending it off again has not worked, so cut it from what you promised, split it into smaller pieces, or park it and say what you are waiting on.`, milestoneId: item.milestone.id };
  return { kind: "send", headline: `Send off: ${title}`, why: item.milestone.outcome, milestoneId: item.milestone.id };
}
