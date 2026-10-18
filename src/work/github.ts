import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "./store.ts";
import { cleanText, parseMarkers, withoutMarkers } from "./text.ts";
import type { NewWorkEvent } from "./types.ts";
import type { WorkProject } from "./worktree.ts";

export type RunGhFn = (cwd: string, argv: readonly string[], signal?: AbortSignal) => Promise<string>;
export const GH_CANDIDATES: readonly string[] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
export const GH_ARGV: readonly string[] = ["pr", "list", "--state", "merged", "--limit", "20", "--json", "number,title,mergedAt,body,headRefName"];
export const MAX_GITHUB_PROJECTS = 40;
const CURSOR = "github";
const GITHUB_HOST = /github\.com[:/]/i;

/** Runs read-only `gh` from a fixed absolute path, with an argv array, no prompts and bounded time and output. */
export const defaultRunGh: RunGhFn = async (cwd, argv, signal) => {
  let bin: string | null = null;
  for (const c of GH_CANDIDATES) {
    try { await fs.access(c, constants.X_OK); bin = c; break; } catch { /* try the next one */ }
  }
  if (!bin) throw new Error("gh is not installed");
  const file = bin;
  return new Promise((resolve, reject) => {
    execFile(file, [...argv], {
      cwd, timeout: 15_000, maxBuffer: 1024 * 1024, signal,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
};

export type MergedPr = { number: number; title: string; mergedAt: string; body: string; headRefName: string };

/** Hand-validated `gh pr list --json` output; anything malformed is skipped. */
export function parsePrList(out: string): MergedPr[] {
  let v: unknown;
  try { v = JSON.parse(out); } catch { throw new Error("gh returned something that is not JSON"); }
  if (!Array.isArray(v)) throw new Error("gh returned an unexpected shape");
  return v.flatMap((x: unknown): MergedPr[] => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    const at = typeof r.mergedAt === "string" ? Date.parse(r.mergedAt) : Number.NaN;
    if (typeof r.number !== "number" || !Number.isSafeInteger(r.number) || r.number < 1 || typeof r.title !== "string" || !Number.isFinite(at)) return [];
    return [{ number: r.number, title: r.title, mergedAt: new Date(at).toISOString(), body: typeof r.body === "string" ? r.body : "", headRefName: typeof r.headRefName === "string" ? r.headRefName : "" }];
  });
}

async function onGithub(projectPath: string): Promise<boolean> {
  try { return GITHUB_HOST.test(await readOnlyFs.readHead(path.join(projectPath, ".git", "config"), 64 * 1024)); } catch { return false; }
}

/**
 * Merged pull requests since the last check, for projects whose `.git/config` mentions github.com (a regex test; the
 * URL is never stored). Only the title, markers and a ≤600-char redacted body summary are kept. The first check of a
 * project reports only PRs carrying a `DAVE-Objective:` marker. Never throws: failures are counted.
 */
export async function scanGithub(db: Db, projects: WorkProject[], at: string, runGh: RunGhFn = defaultRunGh, signal?: AbortSignal): Promise<{ events: NewWorkEvent[]; failures: number; checked: number; error: string | null }> {
  const events: NewWorkEvent[] = [];
  let failures = 0, checked = 0;
  let error: string | null = null;
  for (const p of [...projects].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_GITHUB_PROJECTS)) {
    if (signal?.aborted) break;
    if (!(await onGithub(p.path))) continue;
    checked++;
    let prs: MergedPr[];
    try { prs = parsePrList(await runGh(p.path, GH_ARGV, signal)); } catch (e) { failures++; error ??= e instanceof Error ? cleanText(e.message, 200) : "gh failed"; continue; }
    const previous = getCursor(db, CURSOR, p.id);
    const sorted = [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
    for (const pr of sorted) {
      if (previous && pr.mergedAt <= previous) continue;
      const marker = parseMarkers(pr.body);
      if (!previous && !marker.objectiveId) continue;
      const summary = cleanText(withoutMarkers(pr.body), 600);
      events.push({ projectId: p.id, source: "github", ref: `#${pr.number}`, kind: "pr_merged", outcome: "merged", title: cleanText(pr.title || `Pull request #${pr.number}`, 200), summary: summary || null, at: pr.mergedAt, marker });
    }
    const latest = sorted.at(-1)?.mergedAt ?? previous;
    setCursor(db, CURSOR, p.id, latest && previous && previous > latest ? previous : (latest ?? at), at);
  }
  return { events, failures, checked, error };
}
