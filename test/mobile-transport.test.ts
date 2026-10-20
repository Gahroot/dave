/**
 * End-to-end interop: the phone's sealed transport and API client
 * (mobile/src/lib/transport.ts, mobile/src/lib/api.ts) against the real Mac
 * gateway. Isolated fixture home, memory pairing store, ephemeral port on
 * 127.0.0.1 — never the Keychain, ports 4317/4318 or the real data dir.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { memoryPairingStore } from "../src/mobile/pairing-store.ts";
import { createProviderService, type OwnedAuth } from "../src/providers/index.ts";
import { fromBase64Url, newDeviceId, parsePairingLink, randomRootKey, roomId, toHex, type HelloBody, type PairingOffer, type RpcMethod } from "../src/mobile/protocol.ts";
import { call, hello, upload, TransportError, type CallOptions, type CallResult, type TransportDeps } from "../mobile/src/lib/transport.ts";
import { ApiError, createApi, type Api } from "../mobile/src/lib/api.ts";
import { tempDir } from "./helpers.ts";


const apps: FastifyInstance[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
const UNREACHABLE = "192.0.2.1"; // TEST-NET-1; the injected fetch refuses it before any socket opens

const VOICE_TOKEN = "PRIVATE_CHATGPT_ACCESS_TOKEN";
/** Voice wiring with no network and no Keychain: a synthetic ChatGPT token and a fake Realtime mint. */
function fakeVoice() {
  const auth = {
    status: () => ({ provider: "openai", storage: "keychain", state: "connected" }), restore: vi.fn(), connect: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(),
    getCredentials: vi.fn(async () => ({ accessToken: VOICE_TOKEN, accountId: "a", expiresAt: 0 })),
  } as unknown as OwnedAuth;
  const mint = vi.fn(async () => Response.json({ value: "ek_phone_secret", expires_at: 1_900_000_000 }));
  return { mint, providers: createProviderService({ authFactory: () => auth, inference: async () => "{}" }), voice: { fetch: mint as typeof fetch } };
}

async function fixture(extra: { providers?: ReturnType<typeof fakeVoice>["providers"]; voice?: { fetch: typeof fetch } } = {}) {
  const home = tempDir("mobile-transport-"); homes.push(home);
  const store = memoryPairingStore();
  const app = await buildServer(sourcePaths(home, home), {
    ...extra,
    documents: { extractor: async () => ({ unavailable: true }) },
    meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false, inference: async () => "{}" },
    mobile: { store, port: 0, listenHost: "127.0.0.1", hosts: () => ["127.0.0.1"], hostname: () => "Test Mac" },
    startMobileGateway: true,
  });
  apps.push(app);
  await app.ready();
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const status = (await app.inject({ method: "POST", url: "/api/mobile/pairing/enable", headers: { ...headers, "x-dave-csrf": token }, payload: {} })).json();
  expect(status.listening).toBe(true);
  const parsed = parsePairingLink(status.link);
  if (!parsed.ok) throw new Error(parsed.error);
  return { store, offer: parsed.offer };
}

/** A fetch that records every host it is asked for and fails for `UNREACHABLE`. */
function recordingFetch(): { hosts: string[]; deps: TransportDeps } {
  const hosts: string[] = [];
  return {
    hosts,
    deps: {
      fetch: async (url, init) => {
        const host = new URL(url).hostname;
        hosts.push(host);
        if (host === UNREACHABLE) throw new TypeError("fetch failed");
        return fetch(url, { ...init, body: typeof init.body === "string" ? init.body : init.body.slice() });
      },
    },
  };
}

function apiFor(offer: PairingOffer, deviceId: string, host: string, deps: TransportDeps = {}): Api {
  return createApi((method: RpcMethod, path, body, options) => call({ offer, deviceId, host }, method, path, body, options, deps));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected a rejection");
}

describe("phone transport against the Mac gateway", () => {
  it("hello claims the pairing and returns the Mac name", async () => {
    const { store, offer } = await fixture();
    const phone = newDeviceId();
    const answer = await hello(offer, phone);
    expect(answer).toEqual({ host: "127.0.0.1", body: { server: "dave", protocol: 1, name: "Test Mac" } });
    expect(store.read()?.claimedBy).toBe(phone);
  });

  it("reads /api/health and carries a guarded POST to its handler", async () => {
    const { offer } = await fixture();
    const phone = newDeviceId();
    await hello(offer, phone);
    const api = apiFor(offer, phone, "127.0.0.1");
    expect(await api.get<unknown>("/api/health")).toBeTruthy();
    // A 2xx through createApi proves the gateway's same-origin + CSRF framing passed the guard (no 403).
    const settings = await api.post<unknown>("/api/meetings/settings", { paused: true });
    expect(JSON.stringify(settings)).not.toContain("CSRF");
  });

  it("refuses a second device id", async () => {
    const { offer } = await fixture();
    await hello(offer, newDeviceId());
    const error = await rejection(hello(offer, newDeviceId()));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("refused");
  });

  it("reports a key from another pairing as unpaired", async () => {
    const { offer } = await fixture();
    const key = randomRootKey();
    const stranger: PairingOffer = { ...offer, key: toHex(key), room: roomId(key) };
    const error = await rejection(hello(stranger, newDeviceId()));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("unpaired");
  });

  it("fails a GET over to the next advertised host", async () => {
    const { offer: real } = await fixture();
    const offer: PairingOffer = { ...real, hosts: [UNREACHABLE, "127.0.0.1"] };
    const phone = newDeviceId();
    const claimed = await hello(offer, phone, undefined, recordingFetch().deps);
    expect(claimed.host).toBe("127.0.0.1");
    const net = recordingFetch();
    const result = await call({ offer, deviceId: phone, host: UNREACHABLE }, "GET", "/api/health", undefined, {}, net.deps);
    expect(result.status).toBe(200);
    expect(result.host).toBe("127.0.0.1");
    expect(net.hosts).toEqual([UNREACHABLE, "127.0.0.1"]);
  });

  it("never fails a POST over", async () => {
    const { offer: real } = await fixture();
    const offer: PairingOffer = { ...real, hosts: [UNREACHABLE, "127.0.0.1"] };
    const phone = newDeviceId();
    await hello(offer, phone, "127.0.0.1");
    const net = recordingFetch();
    const error = await rejection(call({ offer, deviceId: phone, host: UNREACHABLE }, "POST", "/api/meetings/settings", { paused: true }, {}, net.deps));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("unreachable");
    expect(net.hosts).toEqual([UNREACHABLE]);
  });

  it("surfaces API failures as ApiError with status and body", async () => {
    const { offer } = await fixture();
    const phone = newDeviceId();
    await hello(offer, phone);
    const api = apiFor(offer, phone, "127.0.0.1");
    const missing = await rejection(api.get("/api/definitely-not-a-route"));
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
    expect((missing as ApiError).body).toBeTruthy();
    const bad = await rejection(api.post("/api/meetings/settings", { paused: "yes" }));
    expect(bad).toBeInstanceOf(ApiError);
    expect((bad as ApiError).status).toBe(400);
    expect((bad as ApiError).message).toBeTruthy();
    expect((bad as ApiError).body).toBeTruthy();
  });

  it("shares a document with upload() and reads it back with api.binary()", async () => {
    const { offer } = await fixture();
    const phone = newDeviceId();
    await hello(offer, phone);
    const endpoint = { offer, deviceId: phone, host: "127.0.0.1" };
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 9, 8, 7]);
    const direct = await upload(endpoint, { name: "first.png", bytes: png, projectId: null });
    expect(direct.status).toBe(201);
    const api = createApi((method, path, body, options) => call(endpoint, method, path, body, options), (file, options) => upload(endpoint, file, options));
    const shared = await api.upload<{ document: { id: string; name: string }; duplicate: boolean }>({ name: "second.png", bytes: Uint8Array.from([...png, 1]), projectId: null });
    expect(shared.document.name).toBe("second.png");
    const bytes = await api.binary(`/api/files/${shared.document.id}/content`);
    expect(bytes.contentType).toBe("image/png");
    expect(fromBase64Url(bytes.base64url)).toEqual(Uint8Array.from([...png, 1]));
    const notBinary = await rejection(api.binary(`/api/files/${shared.document.id}`));
    expect(notBinary).toBeInstanceOf(ApiError);
  });

  it("runs a voice session through the tunnel; the ChatGPT token never reaches the phone", async () => {
    const voice = fakeVoice();
    const { offer } = await fixture({ providers: voice.providers, voice: voice.voice });
    const phone = newDeviceId();
    await hello(offer, phone);
    const endpoint = { offer, deviceId: phone, host: "127.0.0.1" };
    const seen: string[] = [];
    const caller = async (method: RpcMethod, path: string, body: unknown, options: CallOptions) => {
      const result = await call(endpoint, method, path, body, options);
      seen.push(JSON.stringify(result.body));
      return result;
    };
    const api = createApi(caller);
    const status = await api.get<{ availability: { state: string } }>("/api/voice/status");
    expect(status.availability.state).toBeTruthy();
    const session = await api.post<{ sessionId: string; secret: string; expiresAt: number }>("/api/voice/sessions", { context: { route: "#focus", projectId: null } });
    expect(session).toMatchObject({ secret: "ek_phone_secret", expiresAt: 1_900_000_000 });
    expect(voice.mint).toHaveBeenCalledTimes(1);
    const base = `/api/voice/sessions/${session.sessionId}`;
    const tool = await api.post<{ output: string }>(`${base}/tools`, { callId: "c1", name: "list_projects", args: {} });
    expect(typeof tool.output).toBe("string");
    expect(await api.post<unknown>(`${base}/end`, { reason: "user", transcript: [] })).toMatchObject({ ok: true });
    expect(seen.join("\n")).not.toContain(VOICE_TOKEN);
  });
});
