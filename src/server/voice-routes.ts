import type { FastifyInstance, FastifyReply } from "fastify";
import { strictObject } from "./provider-routes.ts";
import { SESSION_ID, type VoiceResult, type VoiceService } from "../voice/service.ts";
import { VOICE_TOOL_NAMES } from "../voice/tools.ts";
import { END_REASONS, LIMITS, type EndReason, type PageContext, type TranscriptLine } from "../voice/types.ts";

const bad = (message = "Invalid request") => Object.assign(new Error(message), { statusCode: 400 });
const MAX_ARGS_BYTES = 16 * 1024;
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function pageContext(value: unknown): PageContext {
  strictObject(value, ["route", "projectId"]);
  const { route, projectId } = value;
  if (typeof route !== "string" || route.length > 300 || !/^#?[a-z]*([?/][\w=&%./-]*)?$/i.test(route)) throw bad();
  if (projectId !== null && (typeof projectId !== "string" || !PROJECT_ID.test(projectId))) throw bad();
  return { route, projectId };
}
function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function transcript(v: unknown): TranscriptLine[] {
  if (!Array.isArray(v) || v.length > LIMITS.transcriptLines) throw bad();
  return v.map((line) => {
    strictObject(line, ["role", "text", "at"]);
    const { role, text, at } = line;
    if ((role !== "user" && role !== "assistant" && role !== "system") || typeof text !== "string" || text.length > LIMITS.transcriptLineChars
      || typeof at !== "string" || at.length > 40 || Number.isNaN(Date.parse(at))) throw bad();
    return { role, text, at };
  });
}

function send<T>(reply: FastifyReply, r: VoiceResult<T>) {
  if (r.ok) return r.value;
  if (r.reason === "unknown_session") return reply.code(404).send({ error: "unknown session", message: r.message });
  if (r.reason === "invalid") return reply.code(400).send({ error: "invalid", message: r.message });
  return reply.code(503).send({ error: "voice unavailable", message: r.message, reason: r.reason });
}
function sessionId(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw Object.assign(new Error("unknown session"), { statusCode: 404 });
  return id;
}

export function registerVoiceRoutes(app: FastifyInstance, voice: VoiceService): void {
  app.get("/api/voice/status", async () => voice.status());
  app.post("/api/voice/settings", async (req, reply) => {
    const r = voice.saveSettings(req.body);
    if (!r.ok) return reply.code(400).send({ error: "invalid", message: r.message });
    return voice.status();
  });
  app.post("/api/voice/sessions", async (req, reply) => {
    strictObject(req.body, ["context"]);
    const context = pageContext(req.body.context);
    const controller = new AbortController();
    req.raw.once("close", () => { if (!reply.sent) controller.abort(); });
    return send(reply, await voice.start(context, controller.signal));
  });
  app.post("/api/voice/sessions/:id/tools", async (req, reply) => {
    const id = sessionId(req.params);
    strictObject(req.body, ["callId", "name", "args"], ["userWords"]);
    const { callId, name, args, userWords } = req.body;
    if (userWords !== undefined && (typeof userWords !== "string" || userWords.length > LIMITS.userWordsChars)) throw bad();
    if (typeof callId !== "string" || !callId || callId.length > 128 || !/^[\w.:-]+$/.test(callId)) throw bad();
    if (typeof name !== "string" || !VOICE_TOOL_NAMES.has(name)) throw bad("Unknown tool");
    if (!plainObject(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) throw bad();
    return send(reply, await voice.tool(id, { callId, name, args, ...(userWords !== undefined ? { userWords } : {}) }));
  });
  app.post("/api/voice/sessions/:id/approval", async (req, reply) => {
    const id = sessionId(req.params);
    strictObject(req.body, ["on"]);
    const { on } = req.body;
    if (typeof on !== "boolean") throw bad();
    return send(reply, voice.setApproval(id, on, "button"));
  });
  app.post("/api/voice/sessions/:id/confirm", async (req, reply) => {
    const id = sessionId(req.params);
    strictObject(req.body, ["token", "accept"]);
    const { token, accept } = req.body;
    if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token) || typeof accept !== "boolean") throw bad();
    return send(reply, await voice.confirm(id, { token, accept }));
  });
  app.post("/api/voice/sessions/:id/end", async (req, reply) => {
    const id = sessionId(req.params);
    strictObject(req.body, ["reason", "transcript"]);
    const raw = req.body.reason;
    const reason = END_REASONS.find((r): r is EndReason => r === raw);
    if (!reason) throw bad();
    return send(reply, voice.end(id, { reason, transcript: transcript(req.body.transcript) }));
  });
  app.get("/api/voice/history", async () => ({ sessions: voice.history() }));
  app.get("/api/voice/memory", async () => voice.memory());
}
