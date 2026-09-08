import path from "node:path";
import { issue, ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { readOnlyFs } from "./read-only-fs.ts";
import type { SourcePaths } from "../shared/paths.ts";

export type SessionDir = {
  dir: string;
  /** Distinct calendar days (UTC) with a session file, from the file names. */
  activeDays: number;
  /** Project cwd as declared in the session header, or decoded from the dir name. */
  cwd: string | null;
  lastActivityAt: string;
  sessionCount: number;
};

/**
 * Session directories are named after the cwd with separators replaced, which is
 * lossy for paths containing `_`. So we take the cwd from the first line of the
 * newest transcript instead — the header record only. Transcript bodies are
 * never read: we read at most one header line per project.
 */
export async function readEzcoderSessionDirs(
  paths: SourcePaths,
): Promise<Result<SessionDir[]>> {
  const root = paths.ezcoder.sessions;
  const names = await readOnlyFs.readdir(root);
  const out: SessionDir[] = [];
  const issues = [];

  for (const name of names) {
    const dir = path.join(root, name);
    const stat = await readOnlyFs.stat(dir);
    if (!stat?.isDirectory()) continue;
    const files = (await readOnlyFs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    let cwd: string | null = null;
    if (files.length > 0) {
      const newest = files.sort().at(-1)!;
      try {
        cwd = headerCwd(await readOnlyFs.readHead(path.join(dir, newest), 8192));
      } catch (e) {
        issues.push(issue("ezcoder-sessions", `unreadable session header: ${e}`, dir));
      }
    }
    out.push({
      dir,
      activeDays: countActiveDays(files),
      cwd: cwd ?? decodeDirName(name),
      lastActivityAt: stat.mtime.toISOString(),
      sessionCount: files.length,
    });
  }
  return ok(out, issues);
}

/**
 * Session files are named `<ISO timestamp>_<id>.jsonl`, so the day prefix gives
 * distinct active days without opening a single file.
 */
function countActiveDays(files: string[]): number {
  const days = new Set<string>();
  for (const f of files) {
    const day = /^(\d{4}-\d{2}-\d{2})T/.exec(f)?.[1];
    if (day) days.add(day);
  }
  return days.size;
}

/** Parses the first JSONL record and returns its `cwd`, if it has one. */
function headerCwd(head: string): string | null {
  const firstLine = head.split("\n", 1)[0];
  if (!firstLine) return null;
  try {
    const rec = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof rec.cwd === "string" && rec.cwd.startsWith("/") ? rec.cwd : null;
  } catch {
    // Truncated or non-JSON first line: fall back to the directory name.
    return null;
  }
}

/**
 * Fallback only. `Users_groot_my_app` is ambiguous between `/Users/groot/my_app`
 * and `/Users/groot/my/app`; we take the naive decoding and let existence checks
 * drop it if wrong.
 * simplification: naive `_`→`/` decoding; upgrade path is the header cwd above,
 * which is already preferred whenever a readable transcript header exists.
 */
function decodeDirName(name: string): string | null {
  if (!name.startsWith("Users_") && !name.startsWith("home_")) return null;
  return "/" + name.replaceAll("_", "/");
}
