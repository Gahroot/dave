/**
 * DAVE phone pairing wire protocol. Pure on purpose: the same module runs on the
 * Mac (Node) and on the phone (Hermes), so both ends agree on the key schedule
 * and framing by construction rather than by keeping two copies in step.
 *
 * Design follows the pew2 pairing model (read locally, not copied):
 *   - one 32-byte root key per pairing, minted with a CSPRNG;
 *   - the root key reaches the phone only in the QR link's fragment;
 *   - a non-secret room id derived one-way from the key names the pairing on
 *     the wire, so the LAN listener can refuse strangers before decrypting;
 *   - every request and response is sealed with XChaCha20-Poly1305 under a
 *     per-direction HKDF key, with the routing fields bound as associated data;
 *   - requests carry a timestamp and a random id; the Mac rejects stale and
 *     repeated ids (see the gateway), so a captured frame cannot be replayed.
 *
 * No Node, DOM or React Native imports: only @noble primitives, which are pure
 * JS and identical on every runtime. Randomness comes from
 * `globalThis.crypto.getRandomValues` (Node 24; Expo installs it at app entry)
 * or an injected source in tests.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const MOBILE_PROTOCOL_VERSION = 1;
/** LAN port the opt-in phone listener binds by default (`PCC_MOBILE_PORT`). */
export const DEFAULT_MOBILE_PORT = 4318;
/** The gateway's JSON endpoint. Everything else on the LAN listener is 404, except {@link UPLOAD_PATH}. */
export const RPC_PATH = "/v1/rpc";
/** Binary endpoint for one document upload (`POST /api/files`). See {@link sealUpload}. */
export const UPLOAD_PATH = "/v1/upload";
/** The only API path an upload frame may target. */
export const UPLOAD_API_PATH = "/api/files";
/** Largest document the phone may share, matching the Mac's upload ceiling (25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Upload header JSON ceiling inside the sealed frame. */
export const MAX_UPLOAD_HEADER_BYTES = 4 * 1024;
/** Sealed upload frame ceiling on the wire: nonce + length prefix + header + file + tag. */
export const MAX_SEALED_UPLOAD_BYTES = 24 + 4 + MAX_UPLOAD_HEADER_BYTES + MAX_UPLOAD_BYTES + 16;
/** Binary response bodies (images, PDFs) the gateway will carry back, base64url inside the sealed frame. */
export const MAX_BINARY_RESPONSE_BYTES = MAX_UPLOAD_BYTES;
/** Header carrying the room id. Not a secret; a pre-decryption filter only. */
export const ROOM_HEADER = "x-dave-room";
export const ROOT_KEY_BYTES = 32;
export const NONCE_BYTES = 24;
/** How far a request timestamp may differ from the Mac's clock. */
export const REQUEST_SKEW_MS = 120_000;
/** Plaintext request body ceiling, matching the loopback guard's 64 KiB. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Sealed request ceiling on the wire (base64 + framing overhead). */
export const MAX_SEALED_REQUEST_BYTES = 128 * 1024;
export const ROOM_ID_PATTERN = /^[0-9a-f]{48}$/;
export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
export const DEVICE_ID_PATTERN = /^phone-[0-9a-f]{32}$/;

const INFO = {
  room: "dave/mobile/room/v1",
  daemonToApp: "dave/mobile/mac-to-phone/v1",
  appToDaemon: "dave/mobile/phone-to-mac/v1",
} as const;

export type Direction = "mac-to-phone" | "phone-to-mac";
export type RandomBytes = (length: number) => Uint8Array;

export const secureRandom: RandomBytes = (length) => {
  const source = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(array: T) => T } }).crypto;
  if (!source?.getRandomValues) throw new Error("No secure random source: crypto.getRandomValues is unavailable");
  const out = new Uint8Array(length);
  source.getRandomValues(out);
  return out;
};

export function randomRootKey(random: RandomBytes = secureRandom): Uint8Array {
  const key = random(ROOT_KEY_BYTES);
  if (key.length !== ROOT_KEY_BYTES) throw new Error("Random source returned the wrong length");
  return key;
}

function derive(rootKey: Uint8Array, info: string, length: number): Uint8Array {
  if (rootKey.length !== ROOT_KEY_BYTES) throw new Error(`Root key must be ${ROOT_KEY_BYTES} bytes`);
  // No salt: the root key is uniformly random (RFC 5869 §3.1). Domain separation is in `info`.
  return hkdf(sha256, rootKey, undefined, utf8Encode(info), length);
}

/** One-way room id for a pairing: 24 bytes as 48 hex characters. */
export function roomId(rootKey: Uint8Array): string {
  return toHex(derive(rootKey, INFO.room, 24));
}

export function directionKey(rootKey: Uint8Array, direction: Direction): Uint8Array {
  return derive(rootKey, direction === "mac-to-phone" ? INFO.daemonToApp : INFO.appToDaemon, 32);
}

/** A sealed frame on the wire. */
export type Envelope = { v: 1; n: string; ct: string };

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && typeof candidate.n === "string" && typeof candidate.ct === "string" &&
    candidate.n.length <= 64 && /^[A-Za-z0-9_-]*$/.test(candidate.n) && /^[A-Za-z0-9_-]*$/.test(candidate.ct);
}

export function sealJson(key: Uint8Array, associatedData: string, message: unknown, random: RandomBytes = secureRandom): Envelope {
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error("Random source returned the wrong length");
  const cipher = xchacha20poly1305(key, nonce, utf8Encode(associatedData));
  return { v: 1, n: toBase64Url(nonce), ct: toBase64Url(cipher.encrypt(utf8Encode(JSON.stringify(message)))) };
}

/** Decrypts or returns undefined. Never says why: wrong key and tampering look the same. */
export function openJson(key: Uint8Array, associatedData: string, envelope: unknown): unknown {
  if (!isEnvelope(envelope)) return undefined;
  try {
    const nonce = fromBase64Url(envelope.n);
    if (nonce.length !== NONCE_BYTES) return undefined;
    const cipher = xchacha20poly1305(key, nonce, utf8Encode(associatedData));
    return JSON.parse(utf8Decode(cipher.decrypt(fromBase64Url(envelope.ct)))) as unknown;
  } catch {
    return undefined;
  }
}

// ── RPC framing ────────────────────────────────────────────────────────────

export type RpcMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly RpcMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type RequestBase = { v: 1; id: string; at: number; device: string };
/** Proves the key and claims the pairing; answered with {@link HelloBody}. */
export type HelloRequest = RequestBase & { t: "hello" };
/** One loopback API call made on the phone's behalf. */
export type ApiRequest = RequestBase & { t: "req"; method: RpcMethod; path: string; body?: unknown };
export type RpcRequest = HelloRequest | ApiRequest;
/**
 * `encoding: "base64url"` marks a binary answer (an image or PDF): `body` is
 * then the base64url bytes and `contentType` the server's media type.
 */
export type RpcResponse = { v: 1; t: "res"; id: string; at: number; status: number; body: unknown; encoding?: "base64url"; contentType?: string };
export type HelloBody = { server: "dave"; protocol: number; name: string };

/** Associated data binds a request to its pairing, and a response to its request. */
export const requestAssociatedData = (room: string): string => `dave/v1|req|${room}`;
export const responseAssociatedData = (room: string, id: string): string => `dave/v1|res|${room}|${id}`;

export function newRequestId(random: RandomBytes = secureRandom): string {
  return toHex(random(16));
}
export function newDeviceId(random: RandomBytes = secureRandom): string {
  return `phone-${toHex(random(16))}`;
}

/**
 * Paths the phone may call: the app's own `/api/*`, minus pairing management
 * (a phone must never rotate, read or widen its own pairing) and the CSRF
 * bootstrap (the gateway attaches tokens itself). Queries allowed; no
 * traversal, fragments, backslashes, doubled slashes or control characters.
 *
 * Every rule is applied to the path as the server will route it: the
 * pathname is percent-decoded once (as Fastify does) before checking, so
 * `/api/%6dobile/…` is refused like `/api/mobile/…`. A pathname that does not
 * decode, or still contains `%` after decoding (double encoding), is refused.
 */
export function isAllowedRpcPath(path: string): boolean {
  if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/api/")) return false;
  if (/[\u0000-\u001f\u007f\\#]/.test(path) || path.includes("//")) return false;
  const [rawPathname = ""] = path.split("?");
  let pathname: string;
  try { pathname = decodeURIComponent(rawPathname); } catch { return false; }
  if (pathname.includes("%") || /[\u0000-\u001f\u007f\\#?]/.test(pathname) || pathname.includes("//") || !pathname.startsWith("/api/")) return false;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return !/^\/api\/(mobile|security)(\/|$)/i.test(pathname);
}

function utf8Length(text: string): number {
  return utf8Encode(text).length;
}

/** Strict shape check after decryption. Unknown fields are refused. */
export function parseRpcRequest(value: unknown): RpcRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || typeof r.id !== "string" || !REQUEST_ID_PATTERN.test(r.id) ||
      typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < 0 ||
      typeof r.device !== "string" || !DEVICE_ID_PATTERN.test(r.device)) return undefined;
  const base = { v: 1 as const, id: r.id, at: r.at, device: r.device };
  if (r.t === "hello") {
    if (Object.keys(r).some((key) => !["v", "t", "id", "at", "device"].includes(key))) return undefined;
    return { ...base, t: "hello" };
  }
  if (r.t !== "req") return undefined;
  if (Object.keys(r).some((key) => !["v", "t", "id", "at", "device", "method", "path", "body"].includes(key))) return undefined;
  if (typeof r.method !== "string" || !METHODS.includes(r.method as RpcMethod)) return undefined;
  if (typeof r.path !== "string" || !isAllowedRpcPath(r.path)) return undefined;
  const method = r.method as RpcMethod;
  if (method === "GET" && r.body !== undefined) return undefined;
  if (r.body !== undefined && utf8Length(JSON.stringify(r.body)) > MAX_REQUEST_BODY_BYTES) return undefined;
  return r.body === undefined ? { ...base, t: "req", method, path: r.path } : { ...base, t: "req", method, path: r.path, body: r.body };
}

export function parseRpcResponse(value: unknown, id: string): RpcResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || r.t !== "res" || r.id !== id || typeof r.at !== "number" || !Number.isSafeInteger(r.at) ||
      typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599 || !("body" in r)) return undefined;
  if (r.encoding === undefined) return { v: 1, t: "res", id, at: r.at, status: r.status, body: r.body };
  if (r.encoding !== "base64url" || typeof r.body !== "string" || !/^[A-Za-z0-9_-]*$/.test(r.body) ||
      typeof r.contentType !== "string" || !CONTENT_TYPE_PATTERN.test(r.contentType)) return undefined;
  return { v: 1, t: "res", id, at: r.at, status: r.status, body: r.body, encoding: "base64url", contentType: r.contentType };
}

const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

/** Phone side: seal a request with the phone-to-Mac key. */
export function sealRequest(rootKey: Uint8Array, request: RpcRequest, random: RandomBytes = secureRandom): Envelope {
  return sealJson(directionKey(rootKey, "phone-to-mac"), requestAssociatedData(roomId(rootKey)), request, random);
}
/** Mac side: open and validate a request. */
export function openRequest(rootKey: Uint8Array, envelope: unknown): RpcRequest | undefined {
  return parseRpcRequest(openJson(directionKey(rootKey, "phone-to-mac"), requestAssociatedData(roomId(rootKey)), envelope));
}
/** Mac side: seal a response bound to the request id. */
export function sealResponse(rootKey: Uint8Array, response: RpcResponse, random: RandomBytes = secureRandom): Envelope {
  return sealJson(directionKey(rootKey, "mac-to-phone"), responseAssociatedData(roomId(rootKey), response.id), response, random);
}
/** Phone side: open a response, refusing one for any other request. */
export function openResponse(rootKey: Uint8Array, id: string, envelope: unknown): RpcResponse | undefined {
  return parseRpcResponse(openJson(directionKey(rootKey, "mac-to-phone"), responseAssociatedData(roomId(rootKey), id), envelope), id);
}

// ── Document upload framing ────────────────────────────────────────────────
//
// Uploads skip JSON and base64 so a 25 MiB photo is sealed once, as bytes:
//   wire  = nonce(24) || XChaCha20-Poly1305(phone-to-Mac key, plaintext, AD = upload|room)
//   plain = headerLength(u32, big-endian) || header JSON (UTF-8) || file bytes
// The header carries the same freshness/replay fields as an RPC request.

export type UploadHeader = RequestBase & { t: "upload"; name: string; project: string | null };
export const uploadAssociatedData = (room: string): string => `dave/v1|upload|${room}`;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

export function parseUploadHeader(value: unknown): UploadHeader | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["v", "t", "id", "at", "device", "name", "project"].includes(key))) return undefined;
  if (r.v !== 1 || r.t !== "upload" || typeof r.id !== "string" || !REQUEST_ID_PATTERN.test(r.id) ||
      typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < 0 ||
      typeof r.device !== "string" || !DEVICE_ID_PATTERN.test(r.device)) return undefined;
  if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > 255 || /[\u0000-\u001f\u007f]/.test(r.name)) return undefined;
  if (r.project !== null && (typeof r.project !== "string" || !PROJECT_ID_PATTERN.test(r.project))) return undefined;
  return { v: 1, t: "upload", id: r.id, at: r.at, device: r.device, name: r.name, project: r.project };
}

/** Phone side: seal one document upload. Throws for a file over {@link MAX_UPLOAD_BYTES} (a caller bug: check first). */
export function sealUpload(rootKey: Uint8Array, header: UploadHeader, file: Uint8Array, random: RandomBytes = secureRandom): Uint8Array {
  if (file.length > MAX_UPLOAD_BYTES) throw new Error("File is larger than the upload limit");
  const headerBytes = utf8Encode(JSON.stringify(header));
  if (headerBytes.length > MAX_UPLOAD_HEADER_BYTES) throw new Error("Upload header is too large");
  const plain = new Uint8Array(4 + headerBytes.length + file.length);
  new DataView(plain.buffer).setUint32(0, headerBytes.length, false);
  plain.set(headerBytes, 4);
  plain.set(file, 4 + headerBytes.length);
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error("Random source returned the wrong length");
  const sealed = xchacha20poly1305(directionKey(rootKey, "phone-to-mac"), nonce, utf8Encode(uploadAssociatedData(roomId(rootKey)))).encrypt(plain);
  const wire = new Uint8Array(NONCE_BYTES + sealed.length);
  wire.set(nonce, 0);
  wire.set(sealed, NONCE_BYTES);
  return wire;
}

/** Mac side: open and validate an upload frame, or undefined (never says why). */
export function openUpload(rootKey: Uint8Array, wire: Uint8Array): { header: UploadHeader; file: Uint8Array } | undefined {
  if (wire.length < NONCE_BYTES + 4 + 16 || wire.length > MAX_SEALED_UPLOAD_BYTES) return undefined;
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(directionKey(rootKey, "phone-to-mac"), wire.subarray(0, NONCE_BYTES), utf8Encode(uploadAssociatedData(roomId(rootKey))))
      .decrypt(wire.subarray(NONCE_BYTES));
  } catch { return undefined; }
  if (plain.length < 4) return undefined;
  const headerLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (headerLength === 0 || headerLength > MAX_UPLOAD_HEADER_BYTES || 4 + headerLength > plain.length) return undefined;
  let header: UploadHeader | undefined;
  try { header = parseUploadHeader(JSON.parse(utf8Decode(plain.subarray(4, 4 + headerLength))) as unknown); } catch { return undefined; }
  if (!header) return undefined;
  const file = plain.subarray(4 + headerLength);
  if (file.length === 0 || file.length > MAX_UPLOAD_BYTES) return undefined;
  return { header, file };
}

/** Within the skew window, and not from before this server process started. */
export function requestIsFresh(at: number, now: number, startedAt = 0): boolean {
  return Math.abs(now - at) <= REQUEST_SKEW_MS && at >= startedAt - 1_000;
}

// ── Pairing link ───────────────────────────────────────────────────────────

/**
 * What the QR carries. The key travels only in the fragment; `room` is
 * redundant with the key and is checked against it, so a link assembled from
 * two different pairings fails at scan time instead of as silent 404s.
 */
export type PairingOffer = { hosts: string[]; port: number; room: string; name: string; key: string };
export type ParsedOffer = { ok: true; offer: PairingOffer } | { ok: false; error: string };

const HOST_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62})(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}))*)$/;
export const MAX_OFFER_HOSTS = 6;

export function cleanDisplayName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._'()-]/gu, "").trim().slice(0, 64) || "DAVE";
}

export function pairingLink(offer: PairingOffer): string {
  const query = [
    `v=${MOBILE_PROTOCOL_VERSION}`,
    `h=${offer.hosts.slice(0, MAX_OFFER_HOSTS).map(encodeURIComponent).join(",")}`,
    `p=${offer.port}`,
    `r=${offer.room}`,
    `n=${encodeURIComponent(cleanDisplayName(offer.name))}`,
  ].join("&");
  return `dave://pair?${query}#k=${toBase64Url(fromHex(offer.key))}`;
}

/** Hand-rolled (no URL class): React Native's URL support is partial. */
export function parsePairingLink(input: string): ParsedOffer {
  const text = input.trim();
  if (!text) return { ok: false, error: "Scan the QR code shown in DAVE → Connections → Phone." };
  const prefix = /^dave:\/\/pair\?/i.exec(text);
  if (!prefix) return { ok: false, error: "That is not a DAVE pairing code. Open DAVE → Connections → Phone on your Mac." };
  const hashAt = text.indexOf("#");
  if (hashAt < 0) return { ok: false, error: "That code has no encryption key. Show a fresh code in DAVE and scan again." };
  const params = new Map<string, string>();
  for (const part of text.slice(prefix[0].length, hashAt).split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    try { params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))); } catch { return { ok: false, error: "That code is damaged. Scan it again." }; }
  }
  const fragment = new Map<string, string>();
  for (const part of text.slice(hashAt + 1).split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) fragment.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (params.get("v") !== String(MOBILE_PROTOCOL_VERSION)) return { ok: false, error: "This code is from a different DAVE version. Update the app on this phone and on your Mac." };
  const hosts = (params.get("h") ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  if (hosts.length === 0 || hosts.length > MAX_OFFER_HOSTS || !hosts.every((host) => host.length <= 253 && HOST_PATTERN.test(host))) {
    return { ok: false, error: "That code has no usable Mac address. Check your Mac is on Wi-Fi and show the code again." };
  }
  const port = Number(params.get("p"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "That code has an invalid port. Show the code again." };
  const room = params.get("r") ?? "";
  if (!ROOM_ID_PATTERN.test(room)) return { ok: false, error: "That code is damaged. Scan it again." };
  let key: Uint8Array;
  try { key = fromBase64Url(fragment.get("k") ?? ""); } catch { return { ok: false, error: "The encryption key in that code is damaged. Scan it again." }; }
  if (key.length !== ROOT_KEY_BYTES) return { ok: false, error: "The encryption key in that code is damaged. Scan it again." };
  if (roomId(key) !== room) return { ok: false, error: "That code does not match itself. Show a fresh code in DAVE and scan again." };
  return { ok: true, offer: { hosts, port, room, name: cleanDisplayName(params.get("n") ?? "DAVE"), key: toHex(key) } };
}

// ── Encoding (pure JS; no Buffer, atob or TextDecoder required) ────────────

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00); i++; }
      else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/** Strict decoder: malformed UTF-8 throws rather than being repaired. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] ?? 0;
    let code: number;
    let need: number;
    if (b0 < 0x80) { code = b0; need = 0; }
    else if (b0 >= 0xc2 && b0 < 0xe0) { code = b0 & 31; need = 1; }
    else if (b0 >= 0xe0 && b0 < 0xf0) { code = b0 & 15; need = 2; }
    else if (b0 >= 0xf0 && b0 < 0xf5) { code = b0 & 7; need = 3; }
    else throw new Error("Invalid UTF-8");
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) throw new Error("Invalid UTF-8");
      code = (code << 6) | (b & 63);
    }
    if ((need === 2 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) || (need === 3 && (code < 0x10000 || code > 0x10ffff))) {
      throw new Error("Invalid UTF-8");
    }
    if (code >= 0x10000) { code -= 0x10000; out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }
    else out += String.fromCharCode(code);
    i += need + 1;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] ?? "";
    out += B64[(n >> 12) & 63] ?? "";
    if (b !== undefined) out += B64[(n >> 6) & 63] ?? "";
    if (c !== undefined) out += B64[n & 63] ?? "";
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("Invalid base64url");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 255); }
  }
  return Uint8Array.from(out);
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new Error("Invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
