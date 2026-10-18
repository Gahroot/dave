/**
 * Sealed request/response over the Mac's opt-in LAN listener.
 *
 * One call = one fresh request id + timestamp, sealed with the phone-to-Mac
 * key, POSTed to `http://<host>:<port>/v1/rpc`, answered with a frame sealed to
 * that id. See docs/mobile-pairing.md for the contract.
 *
 * Mutations are never retried or failed over automatically: a lost response
 * does not prove the Mac did not apply the change, and every retry is a new
 * request id the Mac would apply again. Reads may try the other advertised
 * addresses.
 */
import {
  MAX_UPLOAD_BYTES, ROOM_HEADER, RPC_PATH, UPLOAD_PATH, fromHex, newRequestId, openResponse, sealRequest, sealUpload,
  type HelloBody, type PairingOffer, type RpcMethod, type RpcRequest, type RpcResponse,
} from "../../../src/mobile/protocol.ts";

export type TransportErrorKind =
  | "unreachable" // no answer from any address: Mac asleep, other network, phone access off
  | "timeout"
  | "unpaired"    // the Mac answered but does not know this pairing (rotated, forgotten or off)
  | "refused"     // another phone owns this pairing
  | "clock"       // phone and Mac clocks differ by more than two minutes
  | "rate-limited"
  | "protocol";   // an answer this phone cannot read

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  constructor(kind: TransportErrorKind, message: string) { super(message); this.kind = kind; this.name = "TransportError"; }
}

export const MESSAGES: Record<TransportErrorKind, string> = {
  unreachable: "Can't reach your Mac. Check it is awake, DAVE is running with phone access on, and this phone is on the same Wi-Fi.",
  timeout: "Your Mac took too long to answer. Nothing was retried; check the result before trying again.",
  unpaired: "Your Mac no longer recognises this phone. Phone access may be off, or the pairing was replaced. Pair again from DAVE → Connections → Phone.",
  refused: "This DAVE is paired with another phone. On your Mac open DAVE → Connections → Phone → Pair a new phone, then scan the new code.",
  clock: "This phone's clock and your Mac's differ by more than two minutes. Turn on automatic date and time on both.",
  "rate-limited": "Your Mac is refusing requests for a minute after repeated failures. Wait, then retry.",
  protocol: "Your Mac answered with something this phone cannot read. Update DAVE on both devices, then pair again.",
};

export type Endpoint = { offer: PairingOffer; deviceId: string; host: string };
export type CallOptions = { signal?: AbortSignal; timeoutMs?: number };
type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string | Uint8Array; signal: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;
export type TransportDeps = { fetch?: FetchLike; now?: () => number };

const DEFAULT_TIMEOUT_MS = 30_000;
export const HELLO_TIMEOUT_MS = 6_000;

function hostUrl(host: string, port: number, path: string = RPC_PATH): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`;
}

/** An exact-length ArrayBuffer copy (React Native's fetch sends ArrayBuffer bodies as raw bytes). */
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** What one call answers: a JSON/text body, or base64url bytes with their media type. */
export type CallResult = { status: number; body: unknown; host: string; encoding?: "base64url"; contentType?: string };
const result = (response: RpcResponse, host: string): CallResult => response.encoding
  ? { status: response.status, body: response.body, host, encoding: response.encoding, contentType: response.contentType }
  : { status: response.status, body: response.body, host };

/** A sealed frame for one exchange: JSON for API calls, raw bytes for an upload. */
type Frame = { id: string; path: string; contentType: string; body: (key: Uint8Array) => string | Uint8Array };

/** One sealed exchange with one address. */
async function exchange(endpoint: Endpoint, request: RpcRequest, options: CallOptions, deps: TransportDeps): Promise<RpcResponse> {
  return exchangeFrame(endpoint, { id: request.id, path: RPC_PATH, contentType: "application/json", body: (key) => JSON.stringify(sealRequest(key, request)) }, options, deps);
}

async function exchangeFrame(endpoint: Endpoint, frame: Frame, options: CallOptions, deps: TransportDeps): Promise<RpcResponse> {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, { ...init, body: typeof init.body === "string" ? init.body : arrayBuffer(init.body) }));
  const key = fromHex(endpoint.offer.key);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward);
  try {
    let answer: { status: number; text(): Promise<string> };
    try {
      answer = await doFetch(hostUrl(endpoint.host, endpoint.offer.port, frame.path), {
        method: "POST",
        headers: { "content-type": frame.contentType, [ROOM_HEADER]: endpoint.offer.room },
        body: frame.body(key),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new TransportError(timedOut ? "timeout" : "unreachable", timedOut ? MESSAGES.timeout : MESSAGES.unreachable);
    }
    if (answer.status === 404) throw new TransportError("unpaired", MESSAGES.unpaired);
    if (answer.status === 429) throw new TransportError("rate-limited", MESSAGES["rate-limited"]);
    if (answer.status !== 200) throw new TransportError("protocol", MESSAGES.protocol);
    let sealed: unknown;
    try { sealed = JSON.parse(await answer.text()) as unknown; } catch { throw new TransportError("protocol", MESSAGES.protocol); }
    const response = openResponse(key, frame.id, sealed);
    if (!response) throw new TransportError("protocol", MESSAGES.protocol);
    const body = response.body as { error?: unknown; message?: unknown } | null;
    const gatewayMessage = typeof body?.message === "string" && body.message ? body.message : undefined;
    if (response.status === 401 && body?.error === "clock") throw new TransportError("clock", gatewayMessage ?? MESSAGES.clock);
    if (response.status === 403 && body?.error === "device-refused") throw new TransportError("refused", gatewayMessage ?? MESSAGES.refused);
    return response;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
}

/** Prove the key and claim the pairing; tries every advertised address in order. */
export async function hello(offer: PairingOffer, deviceId: string, preferredHost?: string, deps: TransportDeps = {}):
  Promise<{ host: string; body: HelloBody }> {
  const now = deps.now ?? Date.now;
  const hosts = preferredHost ? [preferredHost, ...offer.hosts.filter((h) => h !== preferredHost)] : offer.hosts;
  let last: TransportError = new TransportError("unreachable", MESSAGES.unreachable);
  for (const host of hosts) {
    try {
      const response = await exchange({ offer, deviceId, host }, { v: 1, t: "hello", id: newRequestId(), at: now(), device: deviceId }, { timeoutMs: HELLO_TIMEOUT_MS }, deps);
      const body = response.body as Partial<HelloBody> | null;
      if (response.status !== 200 || body?.server !== "dave" || typeof body.name !== "string" || typeof body.protocol !== "number") {
        throw new TransportError("protocol", MESSAGES.protocol);
      }
      return { host, body: { server: "dave", protocol: body.protocol, name: body.name } };
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      // A definite answer from the Mac is final; only silence moves on to the next address.
      if (error.kind !== "unreachable" && error.kind !== "timeout") throw error;
      last = error;
    }
  }
  throw last;
}

/** One API call made on the phone's behalf through the Mac's loopback app. */
export async function call(endpoint: Endpoint, method: RpcMethod, path: string, body: unknown, options: CallOptions = {}, deps: TransportDeps = {}):
  Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const request = (): RpcRequest => method === "GET"
    ? { v: 1, t: "req", id: newRequestId(), at: now(), device: endpoint.deviceId, method, path }
    : { v: 1, t: "req", id: newRequestId(), at: now(), device: endpoint.deviceId, method, path, body: body ?? {} };
  try {
    const response = await exchange(endpoint, request(), options, deps);
    return result(response, endpoint.host);
  } catch (error) {
    const silent = error instanceof TransportError && (error.kind === "unreachable" || error.kind === "timeout");
    if (method !== "GET" || !silent || options.signal?.aborted) throw error;
    for (const host of endpoint.offer.hosts.filter((h) => h !== endpoint.host)) {
      try {
        const response = await exchange({ ...endpoint, host }, request(), { ...options, timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, HELLO_TIMEOUT_MS) }, deps);
        return result(response, host);
      } catch (next) {
        if (!(next instanceof TransportError) || (next.kind !== "unreachable" && next.kind !== "timeout")) throw next;
      }
    }
    throw error;
  }
}

export type UploadFile = { name: string; bytes: Uint8Array; projectId: string | null };

/**
 * Share one document (`POST /api/files` on the Mac): the bytes are sealed once
 * and sent raw to the upload endpoint. Like every write, never retried or
 * failed over: the Mac may already have stored it.
 */
export async function upload(endpoint: Endpoint, file: UploadFile, options: CallOptions = {}, deps: TransportDeps = {}): Promise<CallResult> {
  if (file.bytes.length === 0) throw new TransportError("protocol", "That file is empty.");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new TransportError("protocol", "That file is larger than 25 MB, the most DAVE accepts.");
  const now = deps.now ?? Date.now;
  const header = { v: 1 as const, t: "upload" as const, id: newRequestId(), at: now(), device: endpoint.deviceId, name: file.name, project: file.projectId };
  const response = await exchangeFrame(endpoint, {
    id: header.id, path: UPLOAD_PATH, contentType: "application/octet-stream", body: (key) => sealUpload(key, header, file.bytes),
  }, { ...options, timeoutMs: options.timeoutMs ?? 120_000 }, deps);
  return result(response, endpoint.host);
}
