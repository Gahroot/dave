import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest, LightMyRequestResponse } from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  MAX_BINARY_RESPONSE_BYTES, MAX_SEALED_REQUEST_BYTES, MAX_SEALED_UPLOAD_BYTES, MOBILE_PROTOCOL_VERSION, ROOM_HEADER, RPC_PATH,
  UPLOAD_API_PATH, UPLOAD_PATH, openRequest, openUpload, requestIsFresh, sealResponse, toBase64Url,
  type ApiRequest, type HelloBody, type RandomBytes, type UploadHeader, secureRandom,
} from "./protocol.ts";
import { CSRF_HEADER, CSRF_PATH } from "../server/request-guard.ts";

/** The pairing the gateway checks against, read fresh on every request so rotation applies at once. */
export type GatewayPairing = { key: Uint8Array; room: string; claimedBy: string | null };

export type ClaimDecision = "claim" | "ok" | "refuse";
/** Trust on first use: the first device claims; only that device is accepted afterwards. */
export function decideClaim(claimedBy: string | null | undefined, deviceId: string): ClaimDecision {
  if (!claimedBy) return "claim";
  return claimedBy === deviceId ? "ok" : "refuse";
}

export const FAILURE_WINDOW_MS = 60_000;
export const MAX_FAILURES = 30;
export const MAX_TRACKED_IPS = 1024;
export const MAX_REPLAY_ENTRIES = 10_000;
const REPLAY_TTL_MS = 2 * 120_000 + 2_000;

export type GatewayOptions = {
  /** The loopback app requests are dispatched into. */
  app: FastifyInstance;
  /** First configured loopback browser origin; the gateway poses as this same-origin client. */
  origin: string;
  pairing: () => GatewayPairing | null;
  /** Synchronously records the claim in memory; persistence is the caller's job. */
  claim: (deviceId: string) => void;
  name: () => string;
  now?: () => number;
  startedAt?: number;
  random?: RandomBytes;
};

export type RunningGateway = { port: number; close: () => Promise<void> };

const NOT_FOUND = { error: "not found" };

/** What a dispatched call seals back: JSON/text as-is, anything else as base64url bytes. */
type Answer = { status: number; body: unknown; encoding?: "base64url"; contentType?: string };
/** The routing fields every opened frame (RPC or upload) carries. */
type Frame = { id: string; at: number; device: string };

/** Turns an injected loopback response into a sealable answer. */
function answerOf(res: LightMyRequestResponse): Answer {
  const type = String(res.headers["content-type"] ?? "");
  const media = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (media === "application/json") {
    try { return { status: res.statusCode, body: JSON.parse(res.payload) as unknown }; } catch { return { status: res.statusCode, body: res.payload }; }
  }
  if (!media || media.startsWith("text/")) return { status: res.statusCode, body: res.payload };
  if (res.rawPayload.length > MAX_BINARY_RESPONSE_BYTES) {
    return { status: 502, body: { error: "too-large", message: "That file is too large to show on the phone." } };
  }
  return { status: res.statusCode, body: toBase64Url(res.rawPayload), encoding: "base64url", contentType: media };
}

function sameRoom(header: unknown, room: string): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header), b = Buffer.from(room);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Builds the LAN gateway (not yet listening). One route; everything else is a bare 404. */
export function buildGateway(options: GatewayOptions): FastifyInstance {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const random = options.random ?? secureRandom;
  const host = new URL(options.origin).host;
  const failures = new Map<string, number[]>();
  const seen = new Map<string, number>();
  let csrf: string | undefined;

  const recent = (ip: string, at: number): number[] => (failures.get(ip) ?? []).filter((t) => at - t < FAILURE_WINDOW_MS);
  const fail = (ip: string, reply: FastifyReply) => {
    const at = now();
    const list = recent(ip, at);
    list.push(at);
    failures.delete(ip);
    if (failures.size >= MAX_TRACKED_IPS) {
      const oldest = failures.keys().next();
      if (!oldest.done) failures.delete(oldest.value);
    }
    failures.set(ip, list.slice(-(MAX_FAILURES + 1)));
    return reply.code(404).header("cache-control", "no-store").send(NOT_FOUND);
  };

  const fetchCsrf = async (): Promise<string | undefined> => {
    const res = await options.app.inject({ method: "GET", url: CSRF_PATH, headers: { host, origin: options.origin, "sec-fetch-site": "same-origin" } });
    const token = res.statusCode === 200 ? (res.json() as { token?: unknown }).token : undefined;
    csrf = typeof token === "string" ? token : undefined;
    return csrf;
  };

  const dispatch = async (request: ApiRequest): Promise<{ status: number; body: unknown }> => {
    const send = async (token: string | undefined): Promise<LightMyRequestResponse> => {
      const headers: Record<string, string> = { host, origin: options.origin, "sec-fetch-site": "same-origin" };
      if (request.method !== "GET") {
        if (token) headers[CSRF_HEADER] = token;
        headers["content-type"] = "application/json";
      }
      return options.app.inject({
        method: request.method, url: request.path, headers,
        ...(request.method === "GET" ? {} : { payload: JSON.stringify(request.body ?? {}) }),
      });
    };
    let res = await send(request.method === "GET" ? undefined : csrf ?? await fetchCsrf());
    if (res.statusCode === 403 && request.method !== "GET") res = await send(await fetchCsrf());
    return answerOf(res);
  };

  const dispatchUpload = async (header: UploadHeader, file: Uint8Array): Promise<Answer> => {
    const send = (token: string | undefined): Promise<LightMyRequestResponse> => {
      const headers: Record<string, string> = {
        host, origin: options.origin, "sec-fetch-site": "same-origin",
        "content-type": "application/octet-stream", "x-dave-filename": encodeURIComponent(header.name),
      };
      if (token) headers[CSRF_HEADER] = token;
      if (header.project !== null) headers["x-dave-project"] = header.project;
      return options.app.inject({ method: "POST", url: UPLOAD_API_PATH, headers, payload: Buffer.from(file.buffer, file.byteOffset, file.byteLength) });
    };
    let res = await send(csrf ?? await fetchCsrf());
    if (res.statusCode === 403) res = await send(await fetchCsrf());
    return answerOf(res);
  };

  const tooMany = (reply: FastifyReply) => reply.code(429).header("cache-control", "no-store").send({ error: "too many requests" });

  /**
   * The shared pipeline for both endpoints: open (any failure → bare 404), replay cache,
   * freshness, device claim, then run and seal the answer.
   */
  const handle = async <F extends Frame>(req: FastifyRequest, reply: FastifyReply, open: (key: Uint8Array) => F | undefined,
    run: (frame: F) => Promise<Answer>): Promise<FastifyReply> => {
    const ip = req.ip;
    const at = now();
    if (recent(ip, at).length > MAX_FAILURES) return tooMany(reply);
    const pairing = options.pairing();
    if (!pairing || !sameRoom(req.headers[ROOM_HEADER], pairing.room)) return fail(ip, reply);
    const frame = open(pairing.key);
    if (!frame) return fail(ip, reply);

    for (const [id, expiry] of seen) if (expiry <= at) seen.delete(id);
    if (seen.has(frame.id)) return fail(ip, reply);
    if (seen.size >= MAX_REPLAY_ENTRIES) return tooMany(reply);
    seen.set(frame.id, at + REPLAY_TTL_MS);

    const seal = (answer: Answer) => reply.code(200).header("cache-control", "no-store")
      .send(sealResponse(pairing.key, { v: 1, t: "res", id: frame.id, at: now(), ...answer }, random));

    if (!requestIsFresh(frame.at, at, startedAt)) {
      return seal({ status: 401, body: { error: "clock", message: "Your phone's clock does not match your Mac's. Turn on automatic date and time on both, then try again." } });
    }
    const decision = decideClaim(pairing.claimedBy, frame.device);
    if (decision === "refuse") {
      return seal({ status: 403, body: { error: "device-refused", message: "This Mac is paired with another phone. To use this phone, open DAVE → Connections → Phone → Pair a new phone on your Mac and scan the new code." } });
    }
    if (decision === "claim") options.claim(frame.device);
    try {
      return seal(await run(frame));
    } catch {
      return seal({ status: 502, body: { error: "Request failed" } });
    }
  };

  // A LAN peer must deliver its whole request promptly (slow-loris bound); responses may take
  // longer (a full rescan), so there is deliberately no socket inactivity timeout.
  const gateway = Fastify({ logger: false, requestTimeout: 15_000 });
  gateway.removeAllContentTypeParsers();
  gateway.addContentTypeParser("*", { parseAs: "string", bodyLimit: MAX_SEALED_REQUEST_BYTES }, (_req, body, done) => { done(null, body); });
  gateway.setNotFoundHandler((_req, reply) => reply.code(404).header("cache-control", "no-store").send(NOT_FOUND));
  // Oversized or unreadable bodies look like any other stranger: no detail, counted.
  gateway.setErrorHandler((_error, req, reply) => fail(req.ip, reply));

  // Refuse strangers before any body is read: a wrong room never makes the Mac buffer a frame.
  gateway.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (req.method !== "POST" || (path !== RPC_PATH && path !== UPLOAD_PATH)) return;
    if (recent(req.ip, now()).length > MAX_FAILURES) return tooMany(reply);
    const pairing = options.pairing();
    if (!pairing || !sameRoom(req.headers[ROOM_HEADER], pairing.room)) return fail(req.ip, reply);
  });

  gateway.post(RPC_PATH, { bodyLimit: MAX_SEALED_REQUEST_BYTES }, async (req, reply) => handle(req, reply, (key) => {
    try { return openRequest(key, JSON.parse(typeof req.body === "string" ? req.body : "")); } catch { return undefined; }
  }, async (request) => {
    if (request.t === "hello") {
      const hello: HelloBody = { server: "dave", protocol: MOBILE_PROTOCOL_VERSION, name: options.name() };
      return { status: 200, body: hello };
    }
    return dispatch(request);
  }));

  // Uploads are raw sealed bytes, parsed only on this route and only as application/octet-stream.
  void gateway.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_SEALED_UPLOAD_BYTES }, (_req, body, done) => { done(null, body); });
    scope.post(UPLOAD_PATH, { bodyLimit: MAX_SEALED_UPLOAD_BYTES }, async (req, reply) => {
      const wire = req.body;
      let file: Uint8Array = new Uint8Array(0);
      return handle(req, reply, (key) => {
        if (!Buffer.isBuffer(wire)) return undefined;
        const opened = openUpload(key, wire);
        if (!opened) return undefined;
        file = opened.file;
        return opened.header;
      }, (header) => dispatchUpload(header, file));
    });
  });
  return gateway;
}

export async function startGateway(options: GatewayOptions & { port: number; host?: string }): Promise<RunningGateway> {
  const gateway = buildGateway(options);
  try {
    await gateway.listen({ port: options.port, host: options.host ?? "0.0.0.0" });
  } catch (error) {
    await gateway.close().catch(() => undefined);
    throw error;
  }
  const address = gateway.server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { port, close: () => gateway.close() };
}
