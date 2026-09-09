import type { DeliveryGoal, DeliveryState } from "./delivery-schema.ts";
import type { CoordinationState, EvidenceResult } from "./delivery-coordination.ts";

export function semanticGoal(goal: DeliveryGoal | null): string {
  return JSON.stringify(goal ? [goal.goal, goal.intendedUser, goal.workflow, goal.stage] : null);
}
export function reportFailures(report: EvidenceResult): string[] {
  return [
    ...report.criteria.filter(c => c.status !== "met").map(c => `${c.id}: ${c.status}`),
    ...report.commands.filter(c => c.exitCode !== 0).map(c => `${c.command}: ${c.exitCode === null ? "not run" : "failed"}`),
    ...report.blockers,
  ];
}
export function deriveDeliveryProgress(state: DeliveryState, coordination: CoordinationState) {
  const contract = coordination.contract;
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const stale = !coordination.goalMatches || (!!plan && semanticGoal(plan.goal) !== semanticGoal(state.goal));
  const milestones = (plan?.milestones ?? []).map(m => {
    const handoff = coordination.handoffs.find(h => h.planId === plan!.id && h.milestoneId === m.id && h.contractId === contract?.id);
    const report = handoff ? coordination.reports.filter(r => r.handoffId === handoff.id).at(-1) : undefined;
    const decision = report ? coordination.decisions.filter(d => d.milestoneId === m.id && d.reportId === report.id).at(-1) : undefined;
    const prerequisites = contract?.prerequisites.flatMap((p, i) => p.milestones.includes(m.position) && !coordination.resolutions[`p${i}`] ? [`${p.owner}: ${p.text}`] : []) ?? [];
    return { milestone: m, handoff, report, accepted: decision?.action === "accept", prerequisites,
      status: "ready" as "ready" | "waiting" | "handed-off" | "needs-review" | "accepted" };
  });
  for (const item of milestones) {
    const dependencies = item.milestone.dependencies.every(d => milestones[d]?.status === "accepted");
    item.status = stale || !contract || item.milestone.status === "blocked" || item.prerequisites.length || !dependencies ? "waiting" : item.accepted ? "accepted" : item.report ? "needs-review" : item.handoff ? "handed-off" : "ready";
  }
  const uncovered = contract?.criteria.filter(c => !c.milestones.length || c.milestones.some(p => !milestones[p])) ?? [];
  const criteria = contract?.criteria.map((c, i) => ({ id: `c${i}`, text: c.text, accepted: !!c.milestones.length && c.milestones.every(p => milestones[p]?.status === "accepted") })) ?? [];
  const unresolved = contract?.prerequisites.flatMap((p, i) => !coordination.resolutions[`p${i}`] ? [{ id: `p${i}`, ...p }] : []) ?? [];
  const next = milestones.find(m => m.status === "needs-review") ?? milestones.find(m => m.status === "handed-off") ?? milestones.find(m => m.status === "ready");
  return { stale, milestones, next, uncovered, criteria, unresolved,
    readyForReview: !!contract && !stale && !!milestones.length && milestones.every(m => m.status === "accepted") && criteria.every(c => c.accepted) && !unresolved.length && !uncovered.length };
}
