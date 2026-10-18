import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { memoryPairingStore } from "../src/mobile/pairing-store.ts";
import { decideClaim } from "../src/mobile/gateway.ts";
import {
  ROOM_HEADER, RPC_PATH, UPLOAD_PATH, fromBase64Url, fromHex, sealUpload, newDeviceId, newRequestId, openResponse, parsePairingLink, roomId, sealRequest,
  type RpcMethod, type RpcResponse,
} from "../src/mobile/protocol.ts";
import { tempDir } from "./helpers.ts";

const apps: FastifyInstance[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const headers = { host: "localhost:4317", origin: "http://localhost:4317" };

async function fixture() {
  const home = tempDir("mobile-gateway-"); homes.push(home);
  const store = memoryPairingStore();
  const app = await buildServer(sourcePaths(home, home), {
    meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false, inference: async () => "{}" },
    mobile: { store, port: 0, listenHost: "127.0.0.1", hosts: () => ["127.0.0.1"], hostname: () => "Test Mac" },
    startMobileGateway: true,
    documents: { extractor: async () => ({ unavailable: true }) },
  });
  apps.push(app);
  await app.ready();
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const post = async (url: string) => app.inject({ method: "POST", url, headers: { ...headers, "x-dave-csrf": token }, payload: {} });
  const status = (await post("/api/mobile/pairing/enable")).json();
  expect(status.listening).toBe(true);
  const parsed = parsePairingLink(status.link);
  if (!parsed.ok) throw new Error(parsed.error);
  const offer = parsed.offer;
  return { app, store, post, offer, key: fromHex(offer.key), url: `http://127.0.0.1:${offer.port}${RPC_PATH}` };
}

type Fx = Awaited<ReturnType<typeof fixture>>;
async function raw(fx: Fx, body: string, room = fx.offer.room): Promise<Response> {
  return fetch(fx.url, { method: "POST", headers: { "content-type": "application/json", [ROOM_HEADER]: room }, body });
}
async function call(fx: Fx, device: string, extra: { t: "hello" } | { t: "req"; method: RpcMethod; path: string; body?: unknown },
  options: { id?: string; at?: number; key?: Uint8Array } = {}): Promise<RpcResponse> {
  const key = options.key ?? fx.key;
  const id = options.id ?? newRequestId();
  const request = { v: 1 as const, id, at: options.at ?? Date.now(), device, ...extra };
  const res = await fetch(fx.url, { method: "POST", headers: { "content-type": "application/json", [ROOM_HEADER]: roomId(key) }, body: JSON.stringify(sealRequest(key, request as Parameters<typeof sealRequest>[1])) });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const opened = openResponse(fx.key, id, await res.json());
  if (!opened) throw new Error("response did not open");
  return opened;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5]);

async function rawUpload(fx: Fx, wire: Uint8Array, room = fx.offer.room): Promise<Response> {
  return fetch(`http://127.0.0.1:${fx.offer.port}${UPLOAD_PATH}`, { method: "POST", headers: { "content-type": "application/octet-stream", [ROOM_HEADER]: room }, body: Buffer.from(wire) });
}
async function upload(fx: Fx, device: string, file: Uint8Array, options: { id?: string; name?: string } = {}): Promise<{ res: Response; id: string; wire: Uint8Array }> {
  const id = options.id ?? newRequestId();
  const wire = sealUpload(fx.key, { v: 1, t: "upload", id, at: Date.now(), device, name: options.name ?? "photo ü.png", project: null }, file);
  return { res: await rawUpload(fx, wire), id, wire };
}
async function opened(fx: Fx, res: Response, id: string): Promise<RpcResponse> {
  expect(res.status).toBe(200);
  const answer = openResponse(fx.key, id, await res.json());
  if (!answer) throw new Error("response did not open");
  return answer;
}

describe("decideClaim", () => {
  it("claims once, then accepts only the claimant", () => {
    expect(decideClaim(null, "phone-a")).toBe("claim");
    expect(decideClaim(undefined, "phone-a")).toBe("claim");
    expect(decideClaim("phone-a", "phone-a")).toBe("ok");
    expect(decideClaim("phone-a", "phone-b")).toBe("refuse");
  });
});

describe("mobile gateway", () => {
  it("hello claims the pairing; a second device is refused", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    const hello = await call(fx, phone, { t: "hello" });
    expect(hello.status).toBe(200);
    expect(hello.body).toEqual({ server: "dave", protocol: 1, name: "Test Mac" });
    expect(fx.store.read()?.claimedBy).toBe(phone);
    expect((await call(fx, phone, { t: "hello" })).status).toBe(200);
    const other = await call(fx, newDeviceId(), { t: "hello" });
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ error: "device-refused" });
    expect(JSON.stringify(other.body)).toContain("Pair a new phone");
    const status = (await fx.app.inject({ url: "/api/mobile/pairing", headers })).json();
    expect(status).toMatchObject({ paired: true, link: null, qrSvg: null });
  });

  it("answers wrong rooms, garbage and other paths with a bare 404", async () => {
    const fx = await fixture();
    const sealed = JSON.stringify(sealRequest(fx.key, { v: 1, t: "hello", id: newRequestId(), at: Date.now(), device: newDeviceId() }));
    expect((await raw(fx, sealed, "0".repeat(48))).status).toBe(404);
    const garbage = await raw(fx, "not json");
    expect(garbage.status).toBe(404);
    expect(await garbage.json()).toEqual({ error: "not found" });
    expect((await raw(fx, JSON.stringify({ v: 1, n: "AAAA", ct: "AAAA" }))).status).toBe(404);
    const base = fx.url.replace(RPC_PATH, "");
    expect((await fetch(`${base}/api/health`)).status).toBe(404);
    expect((await fetch(fx.url)).status).toBe(404);
  });

  it("refuses a replayed request id and seals a clock error", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    const id = newRequestId();
    const request = { v: 1 as const, t: "hello" as const, id, at: Date.now(), device: phone };
    expect((await raw(fx, JSON.stringify(sealRequest(fx.key, request)))).status).toBe(200);
    expect((await raw(fx, JSON.stringify(sealRequest(fx.key, request)))).status).toBe(404);
    const stale = await call(fx, phone, { t: "hello" }, { at: Date.now() - 10 * 60_000 });
    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({ error: "clock" });
  });

  it("tunnels reads and guarded writes into the loopback app, never pairing or security routes", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    await call(fx, phone, { t: "hello" });
    const health = await call(fx, phone, { t: "req", method: "GET", path: "/api/health" });
    expect(health.status).toBe(200);
    const write = await call(fx, phone, { t: "req", method: "POST", path: "/api/meetings/settings", body: { paused: true } });
    expect(write.status).not.toBe(403);
    expect(JSON.stringify(write.body)).not.toContain("CSRF");
    const providers = await call(fx, phone, { t: "req", method: "GET", path: "/api/providers" });
    expect(providers.status).toBe(200);
    for (const path of ["/api/mobile/pairing", "/api/security/csrf", "/api/%6dobile/pairing", "/api/%73ecurity/csrf"]) {
      const sealed = sealRequest(fx.key, { v: 1, t: "req", id: newRequestId(), at: Date.now(), device: phone, method: "GET", path });
      expect((await raw(fx, JSON.stringify(sealed))).status, path).toBe(404);
    }
    // A paired phone can never rotate its own pairing, however the path is spelled.
    const before = (await fx.app.inject({ url: "/api/mobile/pairing", headers })).json() as { createdAt: string | null };
    for (const path of ["/api/%6dobile/pairing/rotate", "/api/mobil%65/pairing/rotate", "/api/MOBILE/pairing/rotate"]) {
      const sealed = sealRequest(fx.key, { v: 1, t: "req", id: newRequestId(), at: Date.now(), device: phone, method: "POST", path, body: {} });
      expect((await raw(fx, JSON.stringify(sealed))).status, path).toBe(404);
    }
    const after = (await fx.app.inject({ url: "/api/mobile/pairing", headers })).json() as { createdAt: string | null; paired: boolean };
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.paired).toBe(true);
  });

  it("rotation refuses the old key immediately", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    await call(fx, phone, { t: "hello" });
    const rotated = (await fx.post("/api/mobile/pairing/rotate")).json();
    expect(rotated).toMatchObject({ paired: false, listening: true });
    const sealed = sealRequest(fx.key, { v: 1, t: "hello", id: newRequestId(), at: Date.now(), device: phone });
    expect((await raw(fx, JSON.stringify(sealed))).status).toBe(404);
    const parsed = parsePairingLink(rotated.link);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.offer.key).not.toBe(fx.offer.key);
    const next = { ...fx, key: fromHex(parsed.offer.key), offer: parsed.offer };
    expect((await call(next, newDeviceId(), { t: "hello" })).status).toBe(200);
  });

  it("rate limits repeated failures from one address", async () => {
    const fx = await fixture();
    for (let i = 0; i < 31; i++) expect((await raw(fx, "x")).status).toBe(404);
    expect((await raw(fx, "x")).status).toBe(429);
  });

  it("stores an uploaded document and answers its meta", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    const { res, id } = await upload(fx, phone, PNG);
    const answer = await opened(fx, res, id);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ duplicate: false, document: { name: "photo ü.png", kind: "image" } });
    expect(fx.store.read()?.claimedBy).toBe(phone);
    const list = await call(fx, phone, { t: "req", method: "GET", path: "/api/files" });
    expect(JSON.stringify(list.body)).toContain("photo ü.png");
  });

  it("returns binary content as base64url with its media type", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    const { res, id } = await upload(fx, phone, PNG);
    const meta = (await opened(fx, res, id)).body as { document: { id: string } };
    const content = await call(fx, phone, { t: "req", method: "GET", path: `/api/files/${meta.document.id}/content` });
    expect(content).toMatchObject({ status: 200, encoding: "base64url", contentType: "image/png" });
    expect(typeof content.body).toBe("string");
    expect(fromBase64Url(String(content.body))).toEqual(PNG);
    const json = await call(fx, phone, { t: "req", method: "GET", path: `/api/files/${meta.document.id}` });
    expect(json.encoding).toBeUndefined();
  });

  it("refuses a replayed upload, a second device and a tampered frame", async () => {
    const fx = await fixture();
    const phone = newDeviceId();
    const first = await upload(fx, phone, PNG);
    expect((await opened(fx, first.res, first.id)).status).toBe(201);
    expect((await rawUpload(fx, first.wire)).status).toBe(404);
    const other = await upload(fx, newDeviceId(), PNG);
    const refused = await opened(fx, other.res, other.id);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "device-refused" });
    const wire = sealUpload(fx.key, { v: 1, t: "upload", id: newRequestId(), at: Date.now(), device: phone, name: "x.png", project: null }, PNG);
    wire[wire.length - 1] = (wire[wire.length - 1] ?? 0) ^ 1;
    const tampered = await rawUpload(fx, wire);
    expect(tampered.status).toBe(404);
    expect(await tampered.json()).toEqual({ error: "not found" });
  });

  it("refuses a wrong room on upload before reading the body", async () => {
    const fx = await fixture();
    // Chunked, never finished: only a reply sent before the body is read can arrive.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: fx.offer.port, path: UPLOAD_PATH, method: "POST",
        headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked", [ROOM_HEADER]: "0".repeat(48) } });
      req.on("response", (res) => { res.resume(); req.destroy(); resolve(res.statusCode ?? 0); });
      req.on("error", (error) => { if (!req.destroyed) reject(error); });
      req.write(Buffer.alloc(1024 * 1024));
    });
    expect(status).toBe(404);
  });
});
