import type { DeliveryState } from "./delivery-schema.ts";
import type { CoordinationState } from "./delivery-coordination.ts";
import { deriveDeliveryProgress } from "./delivery-progress.ts";
import type { MeetingItem } from "../meetings/types.ts";

/** A client requirement or promise that nothing in the plan or finish line accounts for. */
export type RoadmapGap = {
  itemId: string;
  kind: "promise" | "client-ask";
  text: string;
  /** True when the meeting happened after the current plan was written. */
  newSincePlan: boolean;
  meetingTitle: string;
  meetingAt: string;
  dueDate: string | null;
  why: string;
};
export type Roadmap = {
  projectId: string;
  projectName: string;
  /** What "delivered" means, or null when the finish line has not been written down. */
  finish: string | null;
  milestones: { id: string; title: string; status: string }[];
  progress: { milestonesAccepted: number; milestonesTotal: number; criteriaMet: number; criteriaTotal: number };
  gaps: RoadmapGap[];
  /** Why the roadmap itself cannot be trusted yet (no goal, no plan, goal changed). */
  problem: string | null;
};

const STOP = new Set("the a an and or to of for in on at with by from is are be will we you i it that this as into can should could would have has not so then than their our your them they just also more need needs want wants like".split(" "));
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, "");
export function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(w => !STOP.has(w)).map(stem).filter(w => w.length >= 3));
}
/** Share of the requirement's own words found in the covering text. */
export function coverage(requirement: string, covering: string): number {
  const need = words(requirement);
  if (!need.size) return 1;
  const have = words(covering);
  let hit = 0;
  for (const w of need) if (have.has(w)) hit += 1;
  return hit / need.size;
}
export const COVERED_AT = 0.5;

export function buildRoadmap(input: { projectId: string; projectName: string; state: DeliveryState; coordination: CoordinationState; items: readonly MeetingItem[] }): Roadmap {
  const { state, coordination } = input;
  const progress = deriveDeliveryProgress(state, coordination);
  const plan = state.plans.find(p => p.id === state.currentPlanId) ?? null;
  const base = { projectId: input.projectId, projectName: input.projectName };
  const milestones = progress.milestones.map(m => ({ id: m.milestone.id, title: m.milestone.title, status: m.status }));
  const counts = {
    milestonesAccepted: progress.milestones.filter(m => m.status === "accepted").length, milestonesTotal: progress.milestones.length,
    criteriaMet: progress.criteria.filter(c => c.accepted).length, criteriaTotal: progress.criteria.length,
  };
  const finish = coordination.contract?.outcome ?? null;
  const problem = !state.goal ? "No delivery goal is written down." : !coordination.contract ? "No finish line is written down." : progress.stale ? "The goal changed since the plan was made." : !plan ? "There is no plan yet." : null;
  const covering = [state.goal?.goal ?? "", coordination.contract?.outcome ?? "",
    ...(coordination.contract?.criteria.map(c => c.text) ?? []),
    ...(plan?.milestones.flatMap(m => [m.title, m.outcome, ...m.scope, ...m.acceptance]) ?? [])].join(" \n ");
  const planAt = plan ? Date.parse(plan.createdAt) : Number.NaN;
  const gaps: RoadmapGap[] = input.items
    .filter(i => (i.kind === "commitment" || i.kind === "pain_point" || i.kind === "suggestion") && (i.status === "open" || i.status === "planned" || i.status === "looks_done"))
    .filter(i => i.status !== "looks_done" && coverage(`${i.text} ${i.feature ? `${i.feature.title} ${i.feature.outcome}` : ""}`.trim(), covering) < COVERED_AT)
    .map((i): RoadmapGap => {
      const promise = i.kind === "commitment";
      const newSincePlan = Number.isFinite(planAt) && Date.parse(i.meetingAt) > planAt;
      return { itemId: i.id, kind: promise ? "promise" : "client-ask", text: i.text, newSincePlan, meetingTitle: i.meetingTitle, meetingAt: i.meetingAt, dueDate: i.dueDate,
        why: promise ? "You promised this in a meeting and no milestone or finish criterion covers it." : "A client asked for this and nothing in the plan or finish line covers it." };
    })
    // Promises with a deadline first, then newest requirements.
    .sort((a, b) => Number(b.kind === "promise") - Number(a.kind === "promise") || (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9") || b.meetingAt.localeCompare(a.meetingAt));
  return { ...base, finish, milestones, progress: counts, gaps, problem };
}
