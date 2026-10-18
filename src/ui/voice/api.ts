import type { ApprovalRequest, ApprovalState, ConfirmClickRequest, DocumentMeta, EndSessionRequest, StartSessionRequest, StartSessionResponse, ToolCallRequest, ToolCallResponse, UploadResponse, VoiceHistoryEntry, VoiceMemory, VoiceSettings, VoiceStatus, VoiceUnavailableReason } from "../../voice/types.ts";

export class VoiceRequestError extends Error {
  status: number;
  reason: VoiceUnavailableReason | null;
  constructor(message: string, status: number, reason: VoiceUnavailableReason | null = null) { super(message); this.status = status; this.reason = reason; }
}

let csrf: Promise<string> | undefined;
const token = (): Promise<string> => {
  csrf ??= fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
    .then(async r => { if (!r.ok) throw new Error("Security bootstrap failed. Retry when ready."); return (await r.json() as { token: string }).token; })
    .catch((e: unknown) => { csrf = undefined; throw e; });
  return csrf;
};

const REASONS: readonly string[] = ["disabled", "not_connected", "reconnect", "not_entitled", "rate_limited", "mint_failed"];

async function request<T>(method: "GET" | "POST", url: string, init: { body?: BodyInit; json?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  let body: BodyInit | undefined = init.body;
  if (method === "POST") {
    headers["x-dave-csrf"] = await token();
    if (body === undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json ?? {}); }
  }
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, { method, mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new VoiceRequestError(timeout.aborted ? "DAVE took too long to answer. Try again." : "Could not reach DAVE. Try again.", 0);
  }
  let result = null as { message?: string; error?: string; reason?: string } | null;
  try { result = await response.json() as typeof result; } catch { result = null; }
  if (!response.ok) {
    if (response.status === 403) csrf = undefined;
    const reason = result?.reason && REASONS.includes(result.reason) ? result.reason as VoiceUnavailableReason : null;
    const why = response.status === 404 ? "Voice is not available on this server yet." : result?.message ?? result?.error ?? "Request failed.";
    throw new VoiceRequestError(why, response.status, reason);
  }
  return result as T;
}

const enc = encodeURIComponent;

export const voiceApi = {
  status: (signal?: AbortSignal) => request<VoiceStatus>("GET", "/api/voice/status", { signal }),
  settings: (patch: Partial<VoiceSettings>, signal?: AbortSignal) => request<VoiceStatus>("POST", "/api/voice/settings", { json: patch, signal }),
  start: (body: StartSessionRequest, signal?: AbortSignal) => request<StartSessionResponse>("POST", "/api/voice/sessions", { json: body, signal }),
  tool: (sessionId: string, body: ToolCallRequest, signal?: AbortSignal) => request<ToolCallResponse>("POST", `/api/voice/sessions/${enc(sessionId)}/tools`, { json: body, signal, timeoutMs: 90_000 }),
  confirm: (sessionId: string, body: ConfirmClickRequest, signal?: AbortSignal) => request<ToolCallResponse>("POST", `/api/voice/sessions/${enc(sessionId)}/confirm`, { json: body, signal, timeoutMs: 90_000 }),
  approval: (sessionId: string, body: ApprovalRequest, signal?: AbortSignal) => request<ApprovalState>("POST", `/api/voice/sessions/${enc(sessionId)}/approval`, { json: body, signal }),
  end: (sessionId: string, body: EndSessionRequest, signal?: AbortSignal) => request<{ ok: true; summary: string | null }>("POST", `/api/voice/sessions/${enc(sessionId)}/end`, { json: body, signal, timeoutMs: 60_000 }),
  history: (signal?: AbortSignal) => request<{ sessions: VoiceHistoryEntry[] }>("GET", "/api/voice/history", { signal }),
  memory: (signal?: AbortSignal) => request<VoiceMemory>("GET", "/api/voice/memory", { signal }),
  deleteNote: (noteId: string, signal?: AbortSignal) => request<unknown>("POST", `/api/intel/notes/${enc(noteId)}/delete`, { json: {}, signal }),
  upload: (file: File, projectId: string | null, signal?: AbortSignal) => request<UploadResponse>("POST", "/api/files", {
    body: file, signal, timeoutMs: 120_000,
    headers: { "content-type": "application/octet-stream", "x-dave-filename": enc(file.name || "file"), ...(projectId ? { "x-dave-project": projectId } : {}) },
  }),
  document: (id: string, signal?: AbortSignal) => request<DocumentMeta>("GET", `/api/files/${enc(id)}`, { signal }),
  /** Image or PDF bytes for a thumbnail. */
  content: async (id: string, signal: AbortSignal): Promise<Blob> => {
    const response = await fetch(`/api/files/${enc(id)}/content`, { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new VoiceRequestError("Preview unavailable.", response.status);
    return await response.blob();
  },
};
