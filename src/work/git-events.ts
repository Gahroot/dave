import { HEAD_SHA_ARGV, runGit, WORK_LOG_ARGV } from "../adapters/git.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "./store.ts";
import { cleanText } from "./text.ts";
import { DAVE_ID, type NewWorkEvent } from "./types.ts";
import type { WorkProject } from "./worktree.ts";

export type RunGitFn = (cwd: string, argv: readonly string[]) => Promise<string>;
export const MAX_GIT_PROJECTS = 40;
const CURSOR = "git";
const SHA = /^[a-f0-9]{40,64}$/;

export type GitCommit = { sha: string; at: string; parents: string[]; subject: string; objectiveId: string | null };

/** Parses `WORK_LOG_ARGV` output: NUL between fields, RS between records. */
export function parseWorkLog(out: string): GitCommit[] {
  return out.split("\x1e").flatMap((rec) => {
    const [sha, when, parents, subject, trailers] = rec.replace(/^\s+/, "").split("\0");
    const t = when ? Date.parse(when.trim()) : Number.NaN;
    if (!sha || !SHA.test(sha.trim()) || !Number.isFinite(t)) return [];
    const objectiveId = (trailers ?? "").split(",").map((s) => s.trim()).find((s) => DAVE_ID.test(s)) ?? null;
    return [{ sha: sha.trim(), at: new Date(t).toISOString(), parents: (parents ?? "").trim().split(/\s+/).filter(Boolean), subject: (subject ?? "").trim(), objectiveId }];
  });
}

/**
 * New local commits on each project's first-parent history since the last poll. A project is scanned only when its
 * HEAD moved, and only back to the previously seen sha. The first time a project is seen, only commits carrying a
 * `DAVE-Objective:` trailer are reported, so switching DAVE on never floods old history. Allow-listed argv only.
 */
export async function scanGit(db: Db, projects: WorkProject[], at: string, runGitFn: RunGitFn = runGit, signal?: AbortSignal): Promise<{ events: NewWorkEvent[]; failures: number }> {
  const events: NewWorkEvent[] = [];
  let failures = 0;
  for (const p of [...projects].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_GIT_PROJECTS)) {
    signal?.throwIfAborted();
    const previous = getCursor(db, CURSOR, p.id);
    let head: string;
    try { head = (await runGitFn(p.path, HEAD_SHA_ARGV)).trim(); } catch { continue; } // not a repo, or no commits yet
    if (!SHA.test(head) || head === previous) continue;
    let commits: GitCommit[];
    try { commits = parseWorkLog(await runGitFn(p.path, WORK_LOG_ARGV)); } catch { failures++; continue; }
    const fresh: GitCommit[] = [];
    for (const c of commits) { if (c.sha === previous) break; fresh.push(c); }
    for (const c of previous ? fresh : fresh.filter((x) => x.objectiveId)) {
      const merge = c.parents.length >= 2;
      events.push({
        projectId: p.id, source: "git", ref: c.sha, kind: merge ? "merge" : "commit", outcome: merge ? "merged" : "committed",
        title: cleanText(c.subject || "(no subject)", 200), summary: null, at: c.at, marker: { objectiveId: c.objectiveId, itemIds: [] },
      });
    }
    setCursor(db, CURSOR, p.id, head, at);
  }
  return { events, failures };
}
