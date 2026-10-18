import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.ts";
import type { DocumentService } from "../documents/types.ts";
import { OpenAIAuthError } from "../providers/openai-auth.ts";
import type { ProjectList, VoiceIntel, VoiceMeetings, VoicePortfolio, VoiceTriage } from "./deps.ts";
import { grantsApproval } from "./approval.ts";
import { speakable } from "./safety.ts";
import { confirmStore } from "./confirm.ts";
import { voiceContext } from "./context.ts";
import { voiceInstructions } from "./instructions.ts";
import { MINT_MESSAGES, mintRealtimeSecret } from "./mint.ts";
import { realtimeSession } from "./session-config.ts";
import { voiceDisabled, voiceSettingsStore } from "./settings.ts";
import { voiceStore } from "./store.ts";
import { createToolExecutor, VOICE_TOOLS, type PreparedAction } from "./tools.ts";
import {
  MODELS, VOICES, type ApprovalState, type ApprovalVia, type ConfirmClickRequest, type EndSessionRequest, type PageContext, type StartSessionResponse, type ToolCallRequest,
  type ToolCallResponse, type VoiceAvailability, type VoiceHistoryEntry, type VoiceMemory, type VoiceStatus, type VoiceUnavailableReason,
} from "./types.ts";

export const VOICE_DISCLOSURE = "When you talk to DAVE, your conversation, DAVE's tool results and any document DAVE reads for you go to OpenAI Realtime on your ChatGPT account. Meeting transcripts and quotes are never sent. Voice transcripts are stored only on this Mac.";

export const UNAVAILABLE_MESSAGES: Record<VoiceUnavailableReason, string> = {
  disabled: "Voice is turned off on this machine.",
  not_connected: "Connect your ChatGPT account in Connections to talk to DAVE.",
  ...MINT_MESSAGES,
};

export type VoiceServiceDeps = {
  db: Db;
  providers: {
    status(): { openai: { state: string } };
    realtimeAccess(): Promise<{ accessToken: string; accountId: string }>;
  };
  intel: VoiceIntel;
  meetings: VoiceMeetings;
  portfolio: VoicePortfolio;
  documents: DocumentService;
  projects: ProjectList;
  triage: VoiceTriage;
  fetch?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export type VoiceResult<T> = { ok: true; value: T } | { ok: false; reason: VoiceUnavailableReason | "unknown_session" | "invalid"; message: string };

export const SESSION_ID = /^[a-f0-9]{32}$/;

export function createVoiceService(deps: VoiceServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const settings = voiceSettingsStore(deps.db, now);
  const projectName = (id: string): string | null => deps.projects().find((p) => p.id === id)?.name ?? null;
  const store = voiceStore(deps.db, now, projectName);
  const confirms = confirmStore<PreparedAction>(now);
  const executor = createToolExecutor({ intel: deps.intel, meetings: deps.meetings, portfolio: deps.portfolio, documents: deps.documents, projects: deps.projects, triage: deps.triage, store, confirms, now });
  /** Live sessions in this process; anything else is refused. */
  const live = new Map<string, { projectId: string | null; approval: ApprovalState; batches: string[] }>();
  const inflight = new Set<AbortController>();
  let closed = false;

  function availability(): VoiceAvailability {
    if (voiceDisabled(deps.env)) return { state: "unavailable", reason: "disabled", message: UNAVAILABLE_MESSAGES.disabled };
    const state = deps.providers.status().openai.state;
    if (state === "connected") return { state: "ready", reason: null, message: "Ready to talk." };
    if (state === "reconnect_required") return { state: "unavailable", reason: "reconnect", message: UNAVAILABLE_MESSAGES.reconnect };
    return { state: "check_on_start", reason: null, message: "DAVE will check your ChatGPT connection when you start." };
  }
  function status(): VoiceStatus {
    return { settings: settings.get(), availability: availability(), voices: VOICES, models: MODELS, disclosure: VOICE_DISCLOSURE };
  }
  const refuse = <T>(reason: VoiceUnavailableReason): VoiceResult<T> => ({ ok: false, reason, message: UNAVAILABLE_MESSAGES[reason] });

  async function start(context: PageContext, signal?: AbortSignal): Promise<VoiceResult<StartSessionResponse>> {
    if (closed || voiceDisabled(deps.env)) return refuse("disabled");
    let access: { accessToken: string };
    try { access = await deps.providers.realtimeAccess(); }
    catch (e) {
      if (e instanceof OpenAIAuthError && (e.code === "reconnect_required" || e.code === "invalid_credentials")) return refuse("reconnect");
      return refuse("not_connected");
    }
    const s = settings.get();
    const projectId = context.projectId && projectName(context.projectId) ? context.projectId : null;
    const ctx = voiceContext({ intel: deps.intel, lastSummary: () => store.lastSummary(), projectName }, { route: context.route, projectId }, now());
    const session = realtimeSession({ instructions: voiceInstructions(ctx, { greeting: s.greeting }), voice: s.voice, mode: s.mode, tools: VOICE_TOOLS });
    const controller = new AbortController();
    inflight.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const minted = await mintRealtimeSecret({ accessToken: access.accessToken, model: s.model, session, ...(deps.fetch ? { fetch: deps.fetch } : {}), signal: combined });
      if (!minted.ok) return refuse(minted.code);
      if (closed) return refuse("disabled");
      const id = randomBytes(16).toString("hex");
      store.create({ id, projectId, model: minted.model, voice: s.voice });
      live.set(id, { projectId, approval: { on: false, via: null, at: null }, batches: [] });
      return { ok: true, value: { sessionId: id, secret: minted.secret, expiresAt: minted.expiresAt, model: minted.model, voice: s.voice, session, greeting: s.greeting, mode: s.mode } };
    } finally { inflight.delete(controller); }
  }

  const unknown = <T>(): VoiceResult<T> => ({ ok: false, reason: "unknown_session", message: "That voice session has ended." });

  async function tool(sessionId: string, req: ToolCallRequest): Promise<VoiceResult<ToolCallResponse>> {
    const s = live.get(sessionId);
    if (!s) return unknown();
    if (req.name === "approve_session") return { ok: true, value: approveTool(sessionId, req) };
    const r = await executor.execute({ sessionId, projectId: s.projectId, autoApprove: s.approval.on, batches: s.batches }, req);
    return { ok: true, value: r };
  }

  /** Approve all on/off. In memory only: it dies with the live entry (end/close). Journalled in the session's actions. */
  function setApproval(sessionId: string, on: boolean, via: ApprovalVia): VoiceResult<ApprovalState> {
    const s = live.get(sessionId);
    if (!s) return unknown();
    s.approval = on ? { on: true, via, at: now().toISOString() } : { on: false, via: null, at: null };
    const summary = on ? `Approve all turned on (${via})` : "Approve all turned off";
    store.putAction(sessionId, `approval:${now().getTime()}:${randomBytes(4).toString("hex")}`, "approve_session", "done", summary,
      { ok: true, output: JSON.stringify({ done: true, approval: on }) });
    return { ok: true, value: { ...s.approval } };
  }

  const REFUSE_APPROVAL = "Say it yourself, for example 'you have my approval', or press Approve all.";
  function approveTool(sessionId: string, req: ToolCallRequest): ToolCallResponse {
    const prior = store.getAction(sessionId, req.callId);
    if (prior) return prior;
    const on = req.args.on;
    let response: ToolCallResponse;
    if (typeof on !== "boolean") response = { ok: false, output: JSON.stringify({ error: "Send on true or false." }), error: "Send on true or false." };
    else if (on && !grantsApproval(req.userWords)) {
      response = { ok: false, output: JSON.stringify({ approved: false, say: REFUSE_APPROVAL }), error: REFUSE_APPROVAL,
        card: { tone: "amber", title: "Approve all needs you", detail: speakable(REFUSE_APPROVAL, 240) }, ui: { offerApproval: true } };
      store.putAction(sessionId, req.callId, "approve_session", "refused", "Approve all refused: not the user's own words", response);
      return response;
    } else {
      const r = setApproval(sessionId, on, "voice");
      const say = on ? "Approve all is on. I'll make changes without asking until this conversation ends." : "Okay, I'll ask before every change again.";
      response = r.ok ? { ok: true, output: JSON.stringify({ done: true, approval: on, say }), card: { tone: on ? "green" : "gray", title: on ? "Approve all is on" : "Approve all is off", detail: say } }
        : { ok: false, output: JSON.stringify({ error: r.message }), error: r.message };
    }
    store.putAction(sessionId, req.callId, "approve_session", response.ok ? "done" : "refused", response.ok ? "Read: approve_session" : "Failed: approve_session", response);
    return response;
  }
  async function confirm(sessionId: string, req: ConfirmClickRequest): Promise<VoiceResult<ToolCallResponse>> {
    if (!live.has(sessionId)) return unknown();
    return { ok: true, value: await executor.click(sessionId, req) };
  }
  function end(sessionId: string, req: EndSessionRequest): VoiceResult<{ ok: true; summary: string | null }> {
    if (!live.has(sessionId)) return unknown();
    live.delete(sessionId);
    confirms.dropSession(sessionId);
    return { ok: true, value: { ok: true, summary: store.end(sessionId, req.reason, req.transcript) } };
  }
  function history(limit = 20): VoiceHistoryEntry[] { return store.history(limit); }
  function memory(): VoiceMemory {
    let notes: VoiceMemory["notes"] = [];
    try { notes = deps.intel.directionNotes("all", 100).map((n) => ({ ...n, projectName: n.projectId ? projectName(n.projectId) : null })); } catch { notes = []; }
    return { notes };
  }
  function close(): void {
    closed = true;
    for (const c of inflight) c.abort();
    for (const id of live.keys()) store.end(id, "closed", []);
    live.clear();
    confirms.clear();
  }
  return { status, saveSettings: (input: unknown) => settings.save(input), start, tool, confirm, setApproval, end, history, memory, close };
}
export type VoiceService = ReturnType<typeof createVoiceService>;
