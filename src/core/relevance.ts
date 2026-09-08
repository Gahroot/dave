import { classifyTask } from "../attention/today.ts";
import type {
  AgentTask,
  ProjectOverride,
  Relevance,
  RelevanceReason,
  TechnicalActivity,
} from "../shared/types.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Score at or above which a project appears under Active. */
export const ACTIVE_THRESHOLD = 30;

/** simplification: deep reads cap at twelve; rotating coverage is deferred. */
export const ACTIVE_LIMIT = 12;

type Ranked = { id: string; name: string; tasks: AgentTask[]; relevance: Relevance; override: ProjectOverride };
export const hasHumanRequest = (p: Pick<Ranked, "tasks">) => p.tasks.some((t) => classifyTask(t)?.kind === "agent-question");
export const byRelevance = (a: Ranked, b: Ranked) =>
  Number(hasHumanRequest(b)) - Number(hasHumanRequest(a)) ||
  b.relevance.score - a.relevance.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
export function selectActive<T extends Ranked>(projects: T[], limit = ACTIVE_LIMIT): T[] {
  return projects.filter((p) => !p.override.hidden && p.relevance.tier === "active")
    .sort(byRelevance).slice(0, Math.min(ACTIVE_LIMIT, Math.max(0, limit)));
}

function daysAgo(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / DAY_MS;
}

/**
 * Ranks by evidence that a project is live right now: a running worker, open
 * agent work, recent sessions, repeated activity across days, recent commits,
 * and uncommitted work. Nothing here asks the user anything — absence of
 * business metadata never costs a project a single point.
 */
export function scoreRelevance(
  activity: TechnicalActivity,
  tasks: AgentTask[],
  override: ProjectOverride,
  now = new Date(),
): Relevance {
  const reasons: RelevanceReason[] = [];
  const add = (code: RelevanceReason["code"], points: number, detail: string) =>
    reasons.push({ code, points, detail });

  if (tasks.some((t) => classifyTask(t)?.kind === "agent-question")) {
    add("human-request", 100, "unresolved request inferred from task text");
  }

  // Activity remains context, not a human obligation.
  if (activity.runningTaskCount > 0) {
    const stalled = daysAgo(activity.lastAgentSessionAt, now);
    add(
      "running-worker",
      40,
      stalled !== null && stalled * 24 > 24
        ? `${activity.runningTaskCount} task(s) in progress, last session ${Math.floor(stalled * 24)}h ago`
        : `${activity.runningTaskCount} task(s) in progress`,
    );
  }

  // Work queued but not started.
  const pending = tasks.filter((t) => t.status === "pending").length;
  if (pending > 0) add("open-task", Math.min(20, 6 + pending * 2), `${pending} pending task(s)`);

  if (activity.blockedTaskCount > 0) {
    add("blocked-task", 15, `${activity.blockedTaskCount} blocked task(s)`);
  }

  const sessionDays = daysAgo(activity.lastAgentSessionAt, now);
  if (sessionDays !== null) {
    if (sessionDays < 1) add("recent-session", 30, "agent session in the last 24h");
    else if (sessionDays < 3) add("recent-session", 22, `agent session ${Math.round(sessionDays)}d ago`);
    else if (sessionDays < 7) add("recent-session", 14, `agent session ${Math.round(sessionDays)}d ago`);
    else if (sessionDays < 21) add("recent-session", 6, `agent session ${Math.round(sessionDays)}d ago`);
  }

  // Sustained work beats a single burst.
  if (activity.activeDayCount >= 2) {
    add(
      "repeat-activity",
      Math.min(18, activity.activeDayCount * 3),
      `active on ${activity.activeDayCount} separate days recently`,
    );
  }

  const commitDays = daysAgo(activity.lastCommitAt, now);
  if (commitDays !== null) {
    if (commitDays < 2) add("recent-commit", 20, "commit in the last 48h");
    else if (commitDays < 7) add("recent-commit", 12, `last commit ${Math.round(commitDays)}d ago`);
    else if (commitDays < 21) add("recent-commit", 5, `last commit ${Math.round(commitDays)}d ago`);
  }

  // Uncommitted work only counts as live alongside a recent session.
  if (activity.dirty && sessionDays !== null && sessionDays < 14) {
    add(
      "uncommitted-work",
      12,
      activity.dirtyFileCount
        ? `${activity.dirtyFileCount} uncommitted file(s) after a recent session`
        : "uncommitted work after a recent session",
    );
  }

  if (override.pinned) add("pinned", 1000, "you pinned this project");

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  reasons.sort((a, b) => b.points - a.points);

  return {
    score,
    reasons,
    tier: override.hidden ? "other" : score >= ACTIVE_THRESHOLD ? "active" : "other",
  };
}

/** Recency of the newest agent session, in hours. Used for tie-breaks. */
export function hoursSince(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now.getTime() - t) / HOUR_MS;
}
