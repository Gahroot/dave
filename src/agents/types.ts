export type RunStatus = "queued" | "starting" | "running" | "waiting" | "review" | "checking" | "accepted" | "failed" | "stopped" | "interrupted";
export type CheckCommand = { label: string; command: string; args: string[] };
export type CheckResult = CheckCommand & { exitCode: number | null; output: string };
export type ReviewPacket = { fingerprint: string; base: string; head: string; files: string[]; diff: string; checks: CheckResult[]; capturedAt: string };
export type PacketSummary = { id: number; turn: number; fingerprint: string; createdAt: string };
export type Permission = { requestId: string | number; title: string; options: { optionId: string; name: string; kind: string }[] };
export type AgentRun = {
  id: string; projectId: string; projectName: string; projectPath: string; title: string; prompt: string;
  criteria: string[]; checks: CheckCommand[]; dependencies: string[]; handoffId: string | null;
  status: RunStatus; revision: number; workspace: string | null; branch: string; base: string | null;
  sessionId: string | null; turn: number; nextPrompt: string; permission: Permission | null;
  packet: ReviewPacket | null; reason: string; createdAt: string; updatedAt: string;
};
export type RunEvent = { seq: number; kind: string; text: string; createdAt: string };
export type AgentSettings = { enabled: boolean; paused: boolean; maxConcurrent: number; maxPerProject: number; reviewLimit: number; timeoutMinutes: number };
export type AgentOverview = { settings: AgentSettings; runs: AgentRun[]; projects: { id: string; name: string }[]; runner: string };
export const ACTIVE: RunStatus[] = ["starting", "running", "waiting", "checking"];
export const ATTENTION: RunStatus[] = ["waiting", "review", "failed", "interrupted"];
export class AgentError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}
export function text(value: unknown, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) throw new AgentError(400, "Invalid text");
  return value.trim();
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError(400, "Expected an object");
  return value as Record<string, unknown>;
}
export function strings(value: unknown, max = 12): string[] {
  if (!Array.isArray(value) || value.length > max) throw new AgentError(400, "Invalid list");
  return value.map(v => text(v, 2000));
}
export function parseChecks(value: unknown): CheckCommand[] {
  if (!Array.isArray(value) || value.length > 6) throw new AgentError(400, "At most six checks are allowed");
  return value.map(v => {
    const c = object(v);
    if (!Array.isArray(c.args) || c.args.length > 30 || c.args.some(a => typeof a !== "string" || a.length > 2000 || a.includes("\u0000"))) throw new AgentError(400, "Invalid check arguments");
    return { label: text(c.label, 120), command: text(c.command, 500), args: c.args as string[] };
  });
}
// Output is private local data, but common credentials must not enter our logs/UI.
export function clean(value: string, max = 12000): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]").slice(0, max);
}
