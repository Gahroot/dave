import path from "node:path";
import { mkdir, realpath, lstat, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeniedPath } from "../shared/paths.ts";
import { AgentError, clean, type AgentRun, type ReviewPacket } from "./types.ts";
import { git } from "./process.ts";

export async function workspacePath(appHome: string, id: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AgentError(400, "Invalid workspace identity");
  const home = await realpath(appHome), root = path.join(home, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new AgentError(409, "Workspace root must not be a symlink");
  return path.join(root, id);
}
export async function validateWorkspace(appHome: string, run: AgentRun): Promise<string> {
  const expected = await workspacePath(appHome, run.id);
  if (run.workspace !== expected || await realpath(expected) !== expected) throw new AgentError(409, "Workspace path changed");
  if (await git(expected, ["rev-parse", "--show-toplevel"]) !== expected || await git(expected, ["branch", "--show-current"]) !== run.branch) throw new AgentError(409, "Workspace branch changed");
  return expected;
}
export async function prepareWorkspace(appHome: string, run: AgentRun, persist: (workspace: string, base: string) => void, signal: AbortSignal): Promise<string> {
  if (run.workspace) return validateWorkspace(appHome, run);
  const root = await realpath(run.projectPath);
  if (await git(root, ["rev-parse", "--show-toplevel"], signal) !== root) throw new AgentError(409, "Project must be a Git repository root");
  // Never silently exclude the user's current uncommitted work.
  if (await git(root, ["status", "--porcelain", "--untracked-files=normal"], signal)) throw new AgentError(409, "Project has uncommitted work. Commit it outside DAVE before creating a workspace.");
  const base = await git(root, ["rev-parse", "--verify", "HEAD"], signal);
  const destination = await workspacePath(appHome, run.id);
  persist(destination, base); // Durable intent before any external mutation.
  await git(root, ["worktree", "add", "-b", run.branch, destination, base], signal);
  return destination;
}
export async function capture(appHome: string, run: AgentRun, signal?: AbortSignal): Promise<ReviewPacket> {
  const cwd = await validateWorkspace(appHome, run);
  if (!run.base || !/^[a-f0-9]{40,64}$/.test(run.base)) throw new AgentError(409, "Workspace base is missing");
  const head = await git(cwd, ["rev-parse", "HEAD"], signal);
  const names = (await git(cwd, ["diff", "--name-only", "-z", run.base, "--"], signal)).split("\0").filter(Boolean);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], signal)).split("\0").filter(Boolean);
  const files = [...new Set([...names, ...untracked])];
  if (files.length > 200) throw new AgentError(409, "Change is too large for one review; split the assignment");
  if (files.some(f => f.split("/").some(part => isDeniedPath(part)))) throw new AgentError(409, "Credential-shaped files changed; remove them from this assignment before review");
  const diff = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", run.base, "--"], signal);
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
  const hash = createHash("sha256").update(run.base).update(head).update(diff).update(status);
  let display = diff, bytes = Buffer.byteLength(diff);
  for (const file of untracked.sort()) {
    const full = path.resolve(cwd, file);
    if (!full.startsWith(cwd + path.sep)) throw new AgentError(409, "Unexpected file path");
    // Check ancestors as well as the leaf; never follow a symlink outside cwd.
    if (!((await realpath(path.dirname(full))) + path.sep).startsWith(cwd + path.sep)) throw new AgentError(409, "Unexpected linked directory");
    const st = await lstat(full);
    if (!st.isFile() && !st.isSymbolicLink()) throw new AgentError(409, "Unsupported file in workspace");
    if (st.size > 256 * 1024 || bytes + st.size > 512 * 1024) throw new AgentError(409, "Untracked files exceed review size limit");
    const data = st.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full);
    bytes += data.length; hash.update(file).update(String(st.mode)).update(data);
    display += `\nNew file: ${file}\n${data.includes(0) ? "[binary content]" : data.toString("utf8")}\n`;
  }
  return { fingerprint: hash.digest("hex"), base: run.base, head, files: files.map(f => clean(f, 1000)), diff: clean(display, 60000) + (display.length > 60000 ? "\n[Display truncated; inspect the workspace for the complete diff.]" : ""), checks: [], capturedAt: new Date().toISOString() };
}
