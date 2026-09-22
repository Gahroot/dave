import fs from "node:fs";
import path from "node:path";
import { AgentError } from "./types.ts";

/** One runtime may dispatch for an app home. Never kill a PID read from disk. */
export function runtimeLock(appHome: string): () => void {
  const file = path.join(appHome, "agent-runtime.lock");
  function acquire() {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  }
  try { acquire(); } catch(e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let pid: number;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { pid = Number(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
    if (!Number.isSafeInteger(pid) || pid < 1) throw new AgentError(409, "Agent runtime lock is invalid; inspect it before starting");
    try { process.kill(pid, 0); throw new AgentError(409, "Another DAVE runtime is using this app home"); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    fs.unlinkSync(file); // Only an abandoned coordination lock, never user data.
    acquire();
  }
  return () => { fs.unlinkSync(file); };
}
