import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { errorMessage, issue, ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import type { GitAdapter } from "./types.ts";
import type { PortfolioIssue } from "../shared/types.ts";
import type { GitState } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * The only argv shapes this process may ever hand to git. Anything else throws
 * before a process is spawned, so a future edit cannot smuggle in a mutation.
 */
const ALLOWED_ARGV: readonly (readonly string[])[] = [
  ["rev-parse", "--abbrev-ref", "HEAD"],
  ["status", "--porcelain"],
  ["log", "-1", "--format=%cI%x00%s"],
  ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
  // Recent subjects only: evidence for extraction, never file contents.
  ["log", "-10", "--format=%s"],
];

export const RECENT_SUBJECTS_ARGV = ALLOWED_ARGV[4]!;

/** Flags prepended to every invocation: never take a lock, never read a pager. */
const SAFE_PREFIX = ["--no-optional-locks", "--no-pager"];

export class DisallowedGitCommandError extends Error {
  constructor(argv: readonly string[]) {
    super(`git argv not on the read-only allow-list: git ${argv.join(" ")}`);
    this.name = "DisallowedGitCommandError";
  }
}

function isAllowed(argv: readonly string[]): boolean {
  return ALLOWED_ARGV.some(
    (a) => a.length === argv.length && a.every((v, i) => v === argv[i]),
  );
}

/**
 * Single chokepoint for git. execFile (no shell), 5s timeout, no optional locks,
 * allow-listed argv only.
 */
export async function runGit(cwd: string, argv: readonly string[]): Promise<string> {
  if (!isAllowed(argv)) throw new DisallowedGitCommandError(argv);
  const { stdout } = await execFileAsync("git", [...SAFE_PREFIX, ...argv], {
    cwd,
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function isRepo(projectPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(projectPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Recent commit subjects, for evidence extraction. Failures yield no evidence. */
export async function recentCommitSubjects(projectPath: string): Promise<string[]> {
  try {
    return (await runGit(projectPath, RECENT_SUBJECTS_ARGV))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function gitAdapter(): GitAdapter {
  return {
    name: "git",
    async read(projectPath: string): Promise<Result<GitState | null>> {
      if (!(await isRepo(projectPath))) return ok(null);
      const state: GitState = {
        branch: null,
        dirty: null,
        dirtyFileCount: null,
        lastCommitAt: null,
        lastCommitSubject: null,
        ahead: null,
        behind: null,
      };
      const issues: PortfolioIssue[] = [];

      const attempt = async (argv: readonly string[], apply: (out: string) => void) => {
        try {
          apply(await runGit(projectPath, argv));
        } catch (e) {
          issues.push(issue("git", `${argv[0]}: ${errorMessage(e)}`, projectPath));
        }
      };

      await attempt(ALLOWED_ARGV[0]!, (o) => {
        state.branch = o.trim() || null;
      });
      await attempt(ALLOWED_ARGV[1]!, (o) => {
        const lines = o.split("\n").filter((l) => l.trim().length > 0);
        state.dirty = lines.length > 0;
        state.dirtyFileCount = lines.length;
      });
      await attempt(ALLOWED_ARGV[2]!, (o) => {
        const [when, subject] = o.trim().split("\0");
        state.lastCommitAt = when ? new Date(when).toISOString() : null;
        state.lastCommitSubject = subject?.trim() || null;
      });
      // No upstream configured is the common case, not an error worth surfacing.
      try {
        const [behind, ahead] = (await runGit(projectPath, ALLOWED_ARGV[3]!))
          .trim()
          .split(/\s+/)
          .map(Number);
        state.behind = Number.isFinite(behind) ? behind! : null;
        state.ahead = Number.isFinite(ahead) ? ahead! : null;
      } catch {
        state.ahead = null;
        state.behind = null;
      }

      return ok(state, issues);
    },
  };
}
