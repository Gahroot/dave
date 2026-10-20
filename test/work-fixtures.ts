import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tempDir, writeText } from "./helpers.ts";

/** Temp, realpath'd root so canonical paths match on macOS (/var → /private/var). Never the real home. */
export function workRoot(prefix = "dave-work-"): string {
  return fs.realpathSync(tempDir(prefix));
}

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

export function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Initial commit");
}

type Row = Record<string, unknown>;
export const sessionHeader = (id: string, cwd: string): Row => ({ type: "session", version: 2, id, timestamp: "2026-10-12T08:00:00.000Z", cwd });
export const userRow = (text: string, ts = "2026-10-12T08:00:01.000Z"): Row => ({ type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
export const assistantRow = (text: string, ts = "2026-10-12T08:05:00.000Z"): Row => ({ type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
export const runFinished = (generation: number, outcome: string, ts: string): Row => ({ type: "custom", id: `rf${generation}`, parentId: null, timestamp: ts, kind: "run_finished", data: { version: 1, generation, outcome } });

export function writeSession(sessionsDir: string, dirName: string, file: string, rows: Row[]): string {
  const p = path.join(sessionsDir, dirName, file);
  writeText(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
