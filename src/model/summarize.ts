import crypto from "node:crypto";
import { retainedTasks, SUMMARY_POLICY } from "./task-policy.ts";
import type { SessionSummary } from "../adapters/session-summary.ts";
import type {
  AgentTask,
  EvidenceRef,
  ProjectSummary,
  TechnicalActivity,
} from "../shared/types.ts";
import type { ScannedFile } from "../core/evidence-scan.ts";

export type SummaryInput = {
  projectName: string;
  activity: TechnicalActivity;
  tasks: AgentTask[];
  sessions: SessionSummary[];
  docs: ScannedFile[];
  observedAt: string;
};

/**
 * Everything the summary depends on. A project is only re-summarized when this
 * changes, so refreshes are cheap and summaries are stable.
 */
export function summaryFingerprint(input: SummaryInput): string {
  const h = crypto.createHash("sha256");
  h.update(SUMMARY_POLICY);
  h.update(input.activity.lastCommitAt ?? "");
  h.update(input.activity.lastCommitSubject ?? "");
  h.update(String(input.activity.dirtyFileCount ?? ""));
  h.update(input.activity.lastAgentSessionAt ?? "");
  h.update(String(input.activity.sessionCount));
  for (const t of retainedTasks(input.tasks)) h.update(JSON.stringify([t.id, t.status, t.title, t.summary, t.updatedAt]));
  for (const s of input.sessions) h.update(`${s.file}:${s.request ?? ""}:${s.failed}`);
  for (const d of input.docs) h.update(`${d.path}:${d.text.length}`);
  return SUMMARY_POLICY + h.digest("hex");
}

function trim(s: string, max = 180): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Answers the four questions from observed evidence alone. Any question the
 * evidence cannot answer stays null — the user is never asked to fill it in,
 * and an unanswered question is never presented as a problem.
 */
export function summarize(input: SummaryInput): ProjectSummary {
  const at = input.observedAt;
  const evidence: EvidenceRef[] = [];
  const cite = (kind: EvidenceRef["kind"], detail: string, path: string | null = null) => {
    evidence.push({ kind, path, detail: trim(detail, 200), observedAt: at });
  };

  const { activity, sessions } = input;
  const tasks = retainedTasks(input.tasks);
  const newestSession = sessions.find((s) => s.request);

  // 1. What was most recently being worked on.
  let recentFocus: string | null = null;
  const running = tasks.filter((t) => t.status === "in_progress");
  if (newestSession?.request) {
    recentFocus = trim(newestSession.request);
    cite("session", `opening request: ${newestSession.request}`, newestSession.file);
  } else if (running[0]) {
    recentFocus = trim(running[0].title);
    cite("ezboss-task", `task in progress: ${running[0].title}`);
  } else if (activity.lastCommitSubject) {
    recentFocus = trim(activity.lastCommitSubject);
    cite("git", `most recent commit: ${activity.lastCommitSubject}`);
  }

  // 2. What appears to have been completed.
  let completed: string | null = null;
  const done = tasks.filter((t) => t.status === "done");
  if (done.length > 0) {
    const newest = [...done].sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")).at(-1)!;
    completed =
      done.length === 1
        ? trim(newest.title)
        : `${done.length} tasks finished, most recently: ${trim(newest.title, 120)}`;
    cite("ezboss-task", `${done.length} task(s) marked done; latest "${newest.title}"`);
  } else if (activity.recentCommitSubjects.length > 0) {
    completed = `Committed: ${trim(activity.recentCommitSubjects.slice(0, 3).join("; "), 160)}`;
    cite("git", `recent commits: ${activity.recentCommitSubjects.slice(0, 3).join(" | ")}`);
  }

  // 3. What appears unfinished or blocked.
  const unfinishedParts: string[] = [];
  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    unfinishedParts.push(
      blocked.length === 1
        ? `blocked: ${trim(blocked[0]!.title, 120)}`
        : `${blocked.length} blocked tasks`,
    );
    cite("ezboss-task", `blocked task(s): ${blocked.map((t) => t.title).slice(0, 3).join(" | ")}`);
  }
  if (running.length > 0) {
    unfinishedParts.push(
      running.length === 1
        ? `in progress: ${trim(running[0]!.title, 120)}`
        : `${running.length} tasks still in progress`,
    );
    cite("ezboss-task", `in-progress task(s): ${running.map((t) => t.title).slice(0, 3).join(" | ")}`);
  }
  const pending = tasks.filter((t) => t.status === "pending");
  if (pending.length > 0) {
    unfinishedParts.push(`${pending.length} pending`);
    cite("ezboss-task", `pending task(s): ${pending.map((t) => t.title).slice(0, 3).join(" | ")}`);
  }
  if (activity.dirty) {
    unfinishedParts.push(
      activity.dirtyFileCount
        ? `${activity.dirtyFileCount} uncommitted file(s)`
        : "uncommitted changes",
    );
    cite("git", `working tree has uncommitted changes on ${activity.branch ?? "HEAD"}`);
  }
  if (sessions.some((s) => s.failed)) {
    unfinishedParts.push("historical failed run in a session opening; current outcome unknown");
    cite("session", "session prefix recorded a failure; not proof of a current failed run");
  }
  const unfinished = unfinishedParts.length ? capitalize(unfinishedParts.join("; ")) : null;

  // 4. The most likely next action. Always a suggestion.
  let suggestedNextAction: string | null = null;
  if (blocked[0]) {
    suggestedNextAction = `Unblock "${trim(blocked[0].title, 100)}"`;
  } else if (running[0]) {
    suggestedNextAction = `Resume "${trim(running[0].title, 100)}"`;
  } else if (activity.dirty) {
    suggestedNextAction = "Review and commit the uncommitted work";
  } else if (pending[0]) {
    suggestedNextAction = `Start "${trim(pending[0].title, 100)}"`;
  } else if (done.length > 0) {
    suggestedNextAction = "Review the finished agent work";
  } else if (recentFocus) {
    suggestedNextAction = `Continue: ${trim(recentFocus, 100)}`;
  }

  return {
    recentFocus,
    completed,
    unfinished,
    suggestedNextAction,
    evidence,
    generatedAt: at,
    edited: false,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
