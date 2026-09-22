import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { AgentError, clean } from "./types.ts";

export async function executable(command: string): Promise<string> {
  // Resolve against the server's PATH before changing cwd, never a project PATH.
  const candidates = path.isAbsolute(command) ? [command] : command.includes("/") ? [] : (process.env.PATH ?? "").split(path.delimiter).filter(p => path.isAbsolute(p)).map(p => path.join(p, command));
  for (const p of candidates) { try { await access(p, constants.X_OK); return await realpath(p); } catch { /* next */ } }
  throw new AgentError(503, "Required executable is not installed or not executable");
}
export function startProcess(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") throw new AgentError(503, "Managed execution currently requires macOS or Linux");
  // No credentials in argv. Agent-native credential storage remains agent-owned.
  const env = { ...process.env };
  for (const key of ["PCC_HOME", "PCC_BROWSER_ORIGINS", "DAVE_AGENT_COMMAND", "NODE_OPTIONS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"]) delete env[key];
  return spawn(process.execPath, [fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), command, ...args], { cwd, env, detached: true, stdio: "pipe", shell: false });
}
export function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGKILL") {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Group is already gone. Never signal a stored/recycled PID. */ }
}
export async function commandOutput(command: string, args: string[], cwd: string, signal?: AbortSignal, timeout = 30000, cap = 262144): Promise<{ exitCode: number | null; output: string }> {
  signal?.throwIfAborted();
  const child = startProcess(await executable(command), args, cwd);
  return await new Promise((resolve, reject) => {
    let output = "", bytes = 0, exceeded = false;
    const abort = () => killGroup(child);
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const append = (chunk: Buffer) => { bytes += chunk.length; if (bytes > cap) { exceeded = true; abort(); } else output += chunk.toString("utf8"); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new AgentError(503, "Process could not start")); });
    child.on("exit", () => killGroup(child));
    child.on("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); killGroup(child); if (signal?.aborted) reject(new AgentError(409, "Operation stopped")); else resolve({ exitCode: exceeded ? null : code, output: output + (exceeded ? "\nOutput limit reached." : "") }); });
    if (signal?.aborted) abort();
  });
}
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await commandOutput("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], cwd, signal);
  if (r.exitCode !== 0) throw new AgentError(409, "Git operation failed; inspect the repository or retained workspace");
  return r.output.trimEnd();
}
export const safeOutput = (value: string) => clean(value, 24000);
