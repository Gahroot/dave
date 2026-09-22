import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AgentError, clean, object, type Permission } from "./types.ts";
import { executable, startProcess, killGroup } from "./process.ts";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private closed = false;
  private buffer = "";
  private bytes = 0;
  private sessionId = "";
  private permission: Permission | null = null;
  private onOutput: (text: string) => void;
  private onPermission: (permission: Permission | null) => void;
  private constructor(child: ChildProcessWithoutNullStreams, output: (text: string) => void, permission: (p: Permission | null) => void) {
    this.child = child; this.onOutput = output; this.onPermission = permission;
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (data: Buffer) => {
      this.bytes += data.length;
      if (this.bytes > 16 * 1024 * 1024) return this.dispose();
      this.buffer += decoder.write(data);
      if (this.buffer.length > 512 * 1024) return this.dispose();
      let pos: number;
      while ((pos = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, pos); this.buffer = this.buffer.slice(pos + 1); if (line.trim()) this.receive(line); }
    });
    child.stderr.on("data", (data: Buffer) => {
      this.bytes += data.length;
      if (this.bytes > 16 * 1024 * 1024) return this.dispose();
      this.onOutput(clean(data.toString("utf8")));
    });
    child.stdin.on("error", () => this.dispose());
    child.on("error", () => this.dispose());
    child.on("exit", () => this.dispose());
  }
  static async start(command: string, args: string[], cwd: string, output: (text: string) => void, permission: (p: Permission | null) => void) {
    return new AcpClient(startProcess(await executable(command), args, cwd), output, permission);
  }
  private send(value: object) {
    if (this.closed || !this.child.stdin.writable) throw new AgentError(409, "Agent disconnected");
    if (!this.child.stdin.write(JSON.stringify(value) + "\n") && this.child.stdin.writableLength > 256 * 1024) this.dispose();
  }
  request(method: string, params: object, timeout = 30000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new AgentError(409, "Agent disconnected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError(503, "Agent timed out")); this.dispose(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); } catch(e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private receive(line: string) {
    try {
      const msg = object(JSON.parse(line));
      if (msg.jsonrpc !== "2.0") return;
      if (typeof msg.id === "number" && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new AgentError(503, "Agent request failed; inspect activity")); else p.resolve(object(msg.result ?? {}));
        return;
      }
      const params = object(msg.params ?? {});
      if (params.sessionId !== this.sessionId) { if (msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown session" } }); return; }
      if (msg.method === "session/update") {
        const update = object(params.update);
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = object(update.content); if (content.type === "text" && typeof content.text === "string") this.onOutput(content.text);
        } else if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && typeof update.title === "string") this.onOutput(`\nTool: ${clean(update.title, 1000)} (${clean(String(update.status ?? "running"), 40)})\n`);
      } else if (msg.method === "session/request_permission" && (typeof msg.id === "number" || typeof msg.id === "string")) {
        if (this.permission) { this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }); return; }
        const options = Array.isArray(params.options) ? params.options.slice(0, 8).map(v => object(v)).filter(v => typeof v.optionId === "string" && typeof v.name === "string" && typeof v.kind === "string").map(v => ({ optionId: String(v.optionId).slice(0,200), name: clean(String(v.name),200), kind: String(v.kind) })) : [];
        // Persistent permission grants are deliberately not exposed.
        this.permission = { requestId: msg.id, title: clean(String(object(params.toolCall ?? {}).title ?? "Agent requests permission"), 1000), options: options.filter(v => v.kind === "allow_once" || v.kind === "reject_once") };
        this.onPermission(this.permission);
      } else if (msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Client capability not supported" } });
    } catch { this.dispose(); }
  }
  async connect(cwd: string, sessionId: string | null): Promise<string> {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "dave", version: "1" } });
    if (init.protocolVersion !== 1) throw new AgentError(503, "Unsupported agent protocol");
    if (sessionId) {
      if (!object(init.agentCapabilities ?? {}).loadSession) throw new AgentError(409, "This agent cannot resume sessions");
      this.sessionId = sessionId;
      await this.request("session/load", { sessionId, cwd, mcpServers: [] });
    } else {
      const s = await this.request("session/new", { cwd, mcpServers: [] });
      if (typeof s.sessionId !== "string" || !s.sessionId || s.sessionId.length > 256) throw new AgentError(503, "Agent did not supply a session");
      this.sessionId = s.sessionId;
    }
    return this.sessionId;
  }
  async prompt(value: string, timeout: number) { return this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: value }] }, timeout); }
  answer(optionId: string | null) {
    const p = this.permission;
    if (!p || (optionId !== null && !p.options.some(o => o.optionId === optionId))) throw new AgentError(409, "Permission request changed");
    this.send({ jsonrpc: "2.0", id: p.requestId, result: { outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } } });
    this.permission = null; this.onPermission(null);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; killGroup(this.child); this.child.stdin.destroy();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AgentError(503, "Agent disconnected or output limit reached")); }
    this.pending.clear();
  }
}
