import path from "node:path";
import { scoreRelevance } from "../core/relevance.ts";
import { emptySummary } from "../shared/types.ts";
import type { AgentTask, InboxItem, PortfolioProject, ProjectSummary, PortfolioIssue } from "../shared/types.ts";

export const retainedIssue = (issue: PortfolioIssue) =>
  !issue.path || !["tasks.json", "projects.json"].includes(path.basename(issue.path));

export const SUMMARY_POLICY = "attention-v5:no-ezcoder-tasks:";
export const retainedTasks = (tasks: AgentTask[]) => tasks.filter((t) => !t.source.startsWith("ezcoder"));
export const retainedAttention = (item: InboxItem) =>
  !item.evidence.some((e) => e.kind === "ezcoder-task") &&
  !item.subjectKey?.startsWith('["ezcoder');

/** Old generated fields have no per-field provenance: clear, rather than guess.
 * Manual text is never changed; imported evidence is not a manual note.
 */
export function retainedSummary(summary: ProjectSummary, currentPolicy = false): ProjectSummary {
  const evidence = summary.evidence.filter((e) => e.kind !== "ezcoder-task");
  if (summary.edited) return { ...summary, evidence };
  return currentPolicy && evidence.length === summary.evidence.length
    ? summary : emptySummary(summary.generatedAt);
}

/** Projection only: historical snapshots and user outcomes remain in storage. */
export function retainedProject(project: PortfolioProject, now: Date, summary: ProjectSummary): PortfolioProject {
  const tasks = retainedTasks(project.tasks);
  const activity = { ...project.activity,
    openTaskCount: tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    runningTaskCount: tasks.filter((t) => t.status === "in_progress").length,
    blockedTaskCount: tasks.filter((t) => t.status === "blocked").length,
    doneTaskCount: tasks.filter((t) => t.status === "done").length,
    lastTaskUpdateAt: tasks.map((t) => t.updatedAt).filter((v): v is string => !!v).sort().at(-1) ?? null,
  };
  activity.lastTechnicalActivityAt = [activity.lastCommitAt, activity.lastAgentSessionAt, activity.lastTaskUpdateAt]
    .filter((v): v is string => !!v).sort().at(-1) ?? null;
  return { ...project, tasks, activity, summary,
    relevance: scoreRelevance(activity, tasks, project.override, now) };
}
