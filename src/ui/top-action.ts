import type { InboxRow } from "./inbox-model.ts";
import type { Roadmap, RoadmapGap } from "../model/roadmap.ts";

/** What DAVE recommends doing first, why it outranks the rest, and how you will know it is finished. */
export type GapRef = RoadmapGap & { projectId: string; projectName: string };
export type TopAction = {
  /** Set when the action comes from an inbox, agent or delivery row. */
  row: InboxRow | null;
  /** Set when the action is a requirement the roadmap does not cover yet. */
  gap: GapRef | null;
  title: string;
  project: string;
  score: number;
  /** Who or what is stuck until this is done. */
  impact: string;
  /** Plain-words completion test. */
  done: string;
  /** The next few candidates, as short labels. */
  alsoNext: string[];
};

const DAY_MS = 86_400_000;
const AGENT_SCORE = { waiting: 100, review: 80, failed: 75, interrupted: 70 } as const;
const STEP_SCORE = { done: 90, decide: 85, review: 80, unblock: 65, stalled: 60, send: 55, setup: 40, scope: 40, plan: 40, waiting: 0 } as const;

/** Waiting and paused work needs nothing from you, so it is never the next action. */
export function isActionable(row: InboxRow): boolean {
  if (row.source === "delivery") return row.value.state === "active" && row.value.step.kind !== "waiting";
  if (row.source === "agent") return row.value.status in AGENT_SCORE;
  return row.value.status === "open" && row.value.active;
}

export function actionScore(row: InboxRow, now: Date): number {
  const ageDays = row.timestamp && Number.isFinite(Date.parse(row.timestamp)) ? Math.max(0, (now.getTime() - Date.parse(row.timestamp)) / DAY_MS) : 0;
  // Age breaks ties between similar asks; it can never lift an item over a different tier.
  const age = Math.min(ageDays, 9) / 10;
  if (row.source === "agent") return AGENT_SCORE[row.value.status as keyof typeof AGENT_SCORE] + age;
  if (row.source === "delivery") return STEP_SCORE[row.value.step.kind] + age;
  return row.value.urgency + age;
}

function impactOf(row: InboxRow): string {
  if (row.source === "agent") return row.value.status === "waiting" ? "A coding agent is idle until you answer." : "Finished or stopped agent work is sitting unreviewed.";
  if (row.source === "delivery") {
    const kind = row.value.step.kind;
    if (kind === "done") return "Everything promised is built; only your review stands between this and delivery.";
    if (kind === "review") return "Your coding tool is idle until you judge what came back.";
    if (kind === "decide" || kind === "unblock" || kind === "stalled") return "Progress on this project has stopped until this is sorted.";
    if (kind === "send") return "Work is ready to start and nothing is running on it.";
    return "Without this, the project has no clear definition of delivered.";
  }
  const kind = row.value.kind;
  if (kind === "meeting-promise") return "A client is expecting what you promised.";
  if (kind === "client-idea") return "A client suggestion is waiting for a yes or no.";
  if (kind === "approval-request") return "An agent is stopped until you decide.";
  return "A reported problem may be holding the work up.";
}

function doneOf(row: InboxRow): string {
  if (row.source === "agent") {
    const s = row.value.status;
    if (s === "waiting") return "Done when you approve or refuse the request and the run moves on.";
    if (s === "review") return "Done when you accept the evidence or send it back with changes.";
    return "Done when you retry the run or close it without accepting.";
  }
  if (row.source === "delivery") {
    const kind = row.value.step.kind;
    if (kind === "done") return "Done when a person has reviewed the finished work and said it can go to the client.";
    if (kind === "review") return "Done when you accept the work or send it back with a reason.";
    if (kind === "send") return "Done when the piece is handed to your coding tool and a result comes back.";
    if (kind === "decide") return "Done when the stuck piece is cut, split or parked.";
    if (kind === "unblock" || kind === "stalled") return "Done when the blocker is cleared or the piece is sent again.";
    return "Done when the project's goal and finish line are written down.";
  }
  const step = row.value.nextStep?.trim();
  return `${step ? `${step.replace(/\.$/, "")}. ` : ""}Done when you mark it handled, or the evidence shows it is resolved.`;
}

const GAP_SCORE = { promise: 65, "client-ask": 50 } as const;
const rowLabel = (r: InboxRow) => `${r.project} – ${r.source === "request" ? r.reason : r.title}`;
const gapScore = (g: GapRef) => GAP_SCORE[g.kind] + (g.newSincePlan ? 3 : 0);
export const gapsOf = (roadmaps: readonly Roadmap[]): GapRef[] => roadmaps.flatMap(r => r.gaps.map(g => ({ ...g, projectId: r.projectId, projectName: r.projectName })));

/** Picks the single most valuable thing to do now from every source; null when nothing needs you. */
export function pickTopAction(rows: readonly InboxRow[], now = new Date(), roadmaps: readonly Roadmap[] = []): TopAction | null {
  const candidates = [
    ...rows.filter(isActionable).map(row => ({ score: actionScore(row, now), key: row.key, label: rowLabel(row), row, gap: null as GapRef | null })),
    ...gapsOf(roadmaps).map(gap => ({ score: gapScore(gap), key: `gap:${gap.itemId}`, label: `${gap.projectName} – not in the plan: ${gap.text}`, row: null as InboxRow | null, gap })),
  ].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const top = candidates[0];
  if (!top) return null;
  const alsoNext = candidates.slice(1, 4).map(c => c.label);
  if (top.gap) {
    const g = top.gap;
    return { row: null, gap: g, title: g.kind === "promise" ? `Plan what you promised: ${g.text}` : `Decide whether to build: ${g.text}`, project: g.projectName, score: top.score, alsoNext,
      impact: g.kind === "promise" ? "A client is expecting this, and nothing in the roadmap delivers it." : "A client asked for this and the roadmap does not mention it, so it will be missed or surprise you later.",
      done: "Done when it is covered by a milestone or finish criterion in the project's delivery plan, or you drop it." };
  }
  const row = top.row!;
  return { row, gap: null, title: row.source === "request" ? row.reason || row.title : row.title, project: row.project, score: top.score, impact: impactOf(row), done: doneOf(row), alsoNext };
}
