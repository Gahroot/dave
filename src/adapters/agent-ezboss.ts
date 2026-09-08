import path from "node:path";
import { errorMessage, issue, ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { canonicalPath } from "../core/canonical-path.ts";
import { readOnlyFs } from "./read-only-fs.ts";
import { readEzcoderSessionDirs } from "./ezcoder-sessions.ts";
import type { AgentStateAdapter } from "./types.ts";
import type { AgentTask, TaskStatus } from "../shared/types.ts";
import type { AgentActivity } from "./types.ts";
import type { SourcePaths } from "../shared/paths.ts";

export type AgentState = { tasks: AgentTask[]; activity: AgentActivity };

const SUMMARY_MAX = 200;

/** EZBoss uses `in_progress`, EZCoder uses `in-progress`; anything else is unknown. */
export function normalizeStatus(raw: unknown): TaskStatus {
  if (typeof raw !== "string") return "unknown";
  switch (raw.trim().toLowerCase().replace(/-/g, "_")) {
    case "pending":
    case "todo":
      return "pending";
    case "in_progress":
    case "running":
      return "in_progress";
    case "done":
    case "completed":
      return "done";
    case "blocked":
      return "blocked";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function truncate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reads agent task state and activity timestamps. Task prompts are truncated to
 * a short summary and transcript bodies are never opened — only directory
 * mtimes and file counts.
 */
export function ezbossAgentState(
  paths: SourcePaths,
  /** EZBoss plan tasks name a link, not a path; this resolves them. */
  linkNameToPath: Map<string, string>,
): AgentStateAdapter {
  return {
    name: "agent-ezboss",
    async read(): Promise<Result<Map<string, AgentState>>> {
      const byPath = new Map<string, AgentState>();
      const issues = [];

      const entry = (canonical: string, source: string): AgentState => {
        let e = byPath.get(canonical);
        if (!e) {
          e = {
            tasks: [],
            activity: {
              lastActivityAt: null,
              sessionCount: 0,
              activeDays: 0,
              sessionDir: null,
              source,
            },
          };
          byPath.set(canonical, e);
        }
        return e;
      };

      // EZCoder per-project task store.
      const root = paths.ezcoder.taskProjects;
      for (const dir of await readOnlyFs.readdir(root)) {
        const metaPath = path.join(root, dir, "meta.json");
        const tasksPath = path.join(root, dir, "tasks.json");
        try {
          const meta = await readOnlyFs.readJson<{ path?: unknown }>(metaPath);
          if (typeof meta?.path !== "string") continue;
          const list = await readOnlyFs.readJson<unknown>(tasksPath);
          if (list === null) continue;
          if (!Array.isArray(list)) {
            issues.push(issue("agent-ezboss", "tasks.json is not an array", tasksPath));
            continue;
          }
          const e = entry(canonicalPath(meta.path), "ezcoder-tasks");
          for (const t of list as Record<string, unknown>[]) {
            e.tasks.push({
              id: String(t?.id ?? crypto.randomUUID()),
              title: truncate(t?.title) ?? "Untitled task",
              status: normalizeStatus(t?.status),
              summary: truncate(t?.prompt),
              updatedAt: isoOrNull(t?.updatedAt) ?? isoOrNull(t?.createdAt),
              source: "ezcoder-tasks",
            });
          }
        } catch (e) {
          issues.push(issue("agent-ezboss", errorMessage(e), tasksPath));
        }
      }

      // EZBoss plan (often absent — that is normal, not an error).
      try {
        const plan = await readOnlyFs.readJson<{ tasks?: unknown }>(paths.ezboss.plan);
        if (plan && !Array.isArray(plan.tasks)) {
          issues.push(issue("agent-ezboss", "plan.tasks is not an array", paths.ezboss.plan));
        }
        for (const t of (plan?.tasks ?? []) as Record<string, unknown>[]) {
          const project = typeof t?.project === "string" ? t.project : null;
          const target = project ? linkNameToPath.get(project) : undefined;
          if (!target) {
            if (project) {
              issues.push(
                issue("agent-ezboss", `plan task for unknown project "${project}"`, paths.ezboss.plan),
              );
            }
            continue;
          }
          entry(target, "ezboss-plan").tasks.push({
            id: String(t?.id ?? crypto.randomUUID()),
            title: truncate(t?.title) ?? "Untitled task",
            status: normalizeStatus(t?.status),
            summary: truncate(t?.resultSummary ?? t?.notes ?? t?.description),
            updatedAt: isoOrNull(t?.updatedAt) ?? isoOrNull(t?.createdAt),
            source: "ezboss-plan",
          });
        }
      } catch (e) {
        issues.push(issue("agent-ezboss", errorMessage(e), paths.ezboss.plan));
      }

      // Session directories: mtime + count only.
      const sessions = await readEzcoderSessionDirs(paths);
      issues.push(...sessions.issues);
      for (const s of sessions.data) {
        if (!s.cwd) continue;
        const e = entry(canonicalPath(s.cwd), "ezcoder-sessions");
        const merged: AgentActivity = {
          lastActivityAt: s.lastActivityAt,
          sessionCount: e.activity.sessionCount + s.sessionCount,
          activeDays: e.activity.activeDays + s.activeDays,
          sessionDir: s.dir,
          source: "ezcoder-sessions",
        };
        if (!e.activity.lastActivityAt || s.lastActivityAt > e.activity.lastActivityAt) {
          e.activity = merged;
        } else {
          e.activity.sessionCount = merged.sessionCount;
          e.activity.activeDays = merged.activeDays;
        }
      }

      return ok(byPath, issues);
    },
  };
}
