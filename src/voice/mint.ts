/**
 * Mints a short-lived Realtime client secret with the user's ChatGPT access token. Original implementation;
 * the protocol (endpoint and body shape) is OpenAI's GA Realtime API. The token never appears in any result.
 */
import type { RealtimeModel } from "./types.ts";

export const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const MINT_TIMEOUT_MS = 10_000;
export const MINT_MAX_BYTES = 64 * 1024;

export type MintErrorCode = "reconnect" | "not_entitled" | "rate_limited" | "mint_failed";
export type MintResult = { ok: true; secret: string; expiresAt: number; model: RealtimeModel } | { ok: false; code: MintErrorCode; message: string };

export const MINT_MESSAGES: Record<MintErrorCode, string> = {
  reconnect: "OpenAI needs you to reconnect your ChatGPT account in Connections.",
  not_entitled: "Voice is not available on this ChatGPT account.",
  rate_limited: "OpenAI is limiting voice sessions right now. Try again in a minute.",
  mint_failed: "DAVE could not start a voice session with OpenAI. Try again.",
};
const fail = (code: MintErrorCode): MintResult => ({ ok: false, code, message: MINT_MESSAGES[code] });

/** Reads at most `max` bytes; null when the body is larger (the stream is cancelled). */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

export async function mintRealtimeSecret(input: {
  accessToken: string;
  model: RealtimeModel;
  session: Record<string, unknown>;
  ttlSeconds?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MintResult> {
  const doFetch = input.fetch ?? fetch;
  const ttl = input.ttlSeconds ?? 600;
  const timeout = AbortSignal.timeout(MINT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const body = JSON.stringify({ expires_after: { anchor: "created_at", seconds: ttl }, session: { ...input.session, type: "realtime", model: input.model } });
  let response: Response;
  try {
    response = await doFetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body, redirect: "error", signal,
    });
  } catch {
    return fail("mint_failed");
  }
  if (response.status === 401) { await response.body?.cancel().catch(() => undefined); return fail("reconnect"); }
  if (response.status === 403) { await response.body?.cancel().catch(() => undefined); return fail("not_entitled"); }
  if (response.status === 429) { await response.body?.cancel().catch(() => undefined); return fail("rate_limited"); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return fail("mint_failed"); }
  let text: string | null;
  try { text = await readCapped(response, MINT_MAX_BYTES); } catch { return fail("mint_failed"); }
  if (text === null) return fail("mint_failed");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("mint_failed"); }
  if (!parsed || typeof parsed !== "object") return fail("mint_failed");
  const record = parsed as Record<string, unknown>;
  const value = record.value;
  const expiresAt = record.expires_at;
  if (typeof value !== "string" || !value || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return fail("mint_failed");
  return { ok: true, secret: value, expiresAt, model: input.model };
}
