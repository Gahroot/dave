import type { AgentTask, InboxItem, TodayItem } from "../shared/types.ts";

export const TODAY_LIMIT = 3;
export const DAY_MS = 86_400_000;
const QUESTION_RE = /\b(waiting (?:for|on) (?:your|user) (?:input|answer|decision|approval|review)|needs? your (?:approval|decision|input|review)|please (?:confirm|review)|(?:obtain|request|secure) (?:counsel|legal|human|owner|client) (?:sign[- ]off|approval))\b/i;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Inference from unresolved task text, never from activity counts. */
export function classifyTask(task: AgentTask): { kind: "agent-question" | "inspection"; request: string; urgency: number; nextStep: string } | null {
  if (task.status === "done" || task.status === "skipped") return null;
  const request = normalize(`${task.title} ${task.summary ?? ""}`);
  if (QUESTION_RE.test(request)) return {
    kind: "agent-question", request, urgency: 100,
    nextStep: "Read the observed request in project context and supply the requested decision upstream.",
  };
  if (task.status === "blocked" && task.summary?.trim()) return {
    kind: "inspection", request, urgency: 50,
    nextStep: "Inspect the reported blocker; confirm whether your input is actually needed.",
  };
  return null;
}

/** Today is a projection of persisted eligible revisions, not a second heuristic. */
export function buildToday(inbox: InboxItem[], now = new Date()): TodayItem[] {
  return inbox.filter((i) => i.active && i.status === "open" && i.projectId &&
    (!i.snoozedUntil || Date.parse(i.snoozedUntil) <= now.getTime()))
    .slice(0, TODAY_LIMIT).map((i) => ({
      id: i.id, projectId: i.projectId!, projectName: i.projectName ?? "Project",
      title: i.title, why: i.detail, urgency: i.urgency, evidence: i.evidence,
    }));
}
