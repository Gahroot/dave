import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { createProviderService, type OwnedAuth } from "../src/providers/index.ts";
import { OpenAIAuthError } from "../src/providers/openai-auth.ts";
import { tempDir } from "./helpers.ts";

const apps: FastifyInstance[] = []; const homes: string[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const TOKEN = "PRIVATE_ACCESS_TOKEN";
function fakeAuth(credentials: () => Promise<{ accessToken: string; accountId: string; expiresAt: number }>, state = "connected") {
  return { status: () => ({ provider: "openai", storage: "keychain", state }), restore: vi.fn(), connect: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(), getCredentials: vi.fn(credentials) } as unknown as OwnedAuth;
}

async function fixture(auth: OwnedAuth, mint: typeof fetch = async () => Response.json({ value: "ek_route_secret", expires_at: 1_900_000_000 })) {
  const home = tempDir("voice-routes-"); homes.push(home);
  const providers = createProviderService({ authFactory: () => auth, inference: async () => "{}" });
  const mintFetch = vi.fn(mint);
  const app = await buildServer(sourcePaths(home, home), {
    providers,
    meetings: { keyStore: memoryKeyStore(), fetch: (async () => Response.json({ items: [], next_cursor: null })) as typeof fetch, openAIConnected: () => false, inference: async () => "{}" },
    voice: { fetch: mintFetch },
    documents: { extractor: async () => ({ unavailable: true }) },
  });
  apps.push(app);
  const raw = new DatabaseSync(`${home}/pcc.db`);
  raw.exec("INSERT INTO projects VALUES('p1','/w/acme','Acme','2026-01-01','2026-01-01')");
  raw.close();
  const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: { ...headers, "x-dave-csrf": token }, payload });
  return { app, headers, mintFetch, get: (url: string) => app.inject({ url, headers }), post };
}
const start = { context: { route: "#focus", projectId: null } };

describe("voice routes", () => {
  it("guards origin and CSRF and validates bodies", async () => {
    const f = await fixture(fakeAuth(async () => ({ accessToken: TOKEN, accountId: "a", expiresAt: 0 })));
    expect((await f.app.inject({ url: "/api/voice/status" })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/voice/sessions", headers: f.headers, payload: start })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/voice/sessions", headers: { host: "localhost:4317", origin: "https://evil.test" }, payload: start })).statusCode).toBe(403);
    expect((await f.post("/api/voice/sessions", { context: { route: "#focus", projectId: null }, extra: 1 })).statusCode).toBe(400);
    expect((await f.post("/api/voice/settings", { voice: "nobody" })).statusCode).toBe(400);
    expect((await f.post(`/api/voice/sessions/${"a".repeat(32)}/tools`, { callId: "c1", name: "list_projects", args: {} })).statusCode).toBe(404);
    expect(f.mintFetch).not.toHaveBeenCalled();
  });

  it("status is storage-free; settings save", async () => {
    const auth = fakeAuth(async () => ({ accessToken: TOKEN, accountId: "a", expiresAt: 0 }));
    const f = await fixture(auth);
    const s = (await f.get("/api/voice/status")).json();
    expect(s.availability.state).toBe("check_on_start");
    expect(s.disclosure).toContain("OpenAI");
    expect(auth.getCredentials).not.toHaveBeenCalled();
    const saved = (await f.post("/api/voice/settings", { voice: "cedar", mode: "push_to_talk" })).json();
    expect(saved.settings).toMatchObject({ voice: "cedar", mode: "push_to_talk", model: "gpt-realtime-2.1" });
  });

  it("503 with a plain reason when not connected or reconnect is needed", async () => {
    const f = await fixture(fakeAuth(async () => { throw new OpenAIAuthError("reconnect_required"); }));
    const r = await f.post("/api/voice/sessions", start);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ reason: "reconnect" });
    const g = await fixture(fakeAuth(async () => { throw new OpenAIAuthError("storage_unavailable"); }));
    expect((await g.post("/api/voice/sessions", start)).json()).toMatchObject({ reason: "not_connected" });
    const h = await fixture(fakeAuth(async () => ({ accessToken: TOKEN, accountId: "a", expiresAt: 0 })), async () => new Response("no", { status: 403 }));
    const denied = await h.post("/api/voice/sessions", start);
    expect(denied.statusCode).toBe(503);
    expect(denied.json().reason).toBe("not_entitled");
    expect(denied.body).not.toContain(TOKEN);
  });

  it("starts, runs a read tool, confirms set_finish_line, ends and lists history", async () => {
    const f = await fixture(fakeAuth(async () => ({ accessToken: TOKEN, accountId: "a", expiresAt: 0 })));
    const r = await f.post("/api/voice/sessions", start);
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ secret: "ek_route_secret", expiresAt: 1_900_000_000, model: "gpt-realtime-2.1", voice: "marin", greeting: true, mode: "hands_free" });
    expect(r.body).not.toContain(TOKEN);
    expect(s.session).not.toHaveProperty("model");
    const sent = JSON.parse(String(f.mintFetch.mock.calls[0]?.[1]?.body));
    expect(sent.session.model).toBe("gpt-realtime-2.1");
    const base = `/api/voice/sessions/${s.sessionId}`;

    const list = await f.post(`${base}/tools`, { callId: "c1", name: "list_projects", args: {} });
    expect(list.statusCode).toBe(200);
    expect(list.json().output).toContain("Acme");
    expect((await f.post(`${base}/tools`, { callId: "c2", name: "launch_agent", args: {} })).statusCode).toBe(400);

    const prep = (await f.post(`${base}/tools`, { callId: "c3", name: "set_finish_line", args: { project: "acme", finishLine: "Acme books online", acceptance: ["Booking works"] } })).json();
    expect(prep.confirm.token).toMatch(/^[a-f0-9]{32}$/);
    const before = (await f.get("/api/intel/projects/p1")).json();
    expect(before.outcome).toBeNull();
    const ok = await f.post(`${base}/confirm`, { token: prep.confirm.token, accept: true });
    expect(ok.json()).toMatchObject({ ok: true, card: { tone: "green" } });
    expect((await f.get("/api/intel/projects/p1")).json().outcome.desiredOutcome).toBe("Acme books online");

    const end = await f.post(`${base}/end`, { reason: "user", transcript: [{ role: "user", text: "set the goal", at: "2026-10-12T09:00:00.000Z" }] });
    expect(end.json()).toMatchObject({ ok: true });
    expect(end.json().summary).toContain("Acme");
    expect((await f.post(`${base}/tools`, { callId: "c4", name: "list_projects", args: {} })).statusCode).toBe(404);
    const hist = (await f.get("/api/voice/history")).json().sessions;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ lines: 1, endReason: "user" });
    expect((await f.get("/api/voice/memory")).statusCode).toBe(200);
  });

  it("approve all: needs a live session and CSRF; voice grants only with the user's own words; end clears it", async () => {
    const f = await fixture(fakeAuth(async () => ({ accessToken: TOKEN, accountId: "a", expiresAt: 0 })));
    expect((await f.post(`/api/voice/sessions/${"a".repeat(32)}/approval`, { on: true })).statusCode).toBe(404);
    const s = (await f.post("/api/voice/sessions", start)).json();
    const base = `/api/voice/sessions/${s.sessionId}`;
    expect((await f.app.inject({ method: "POST", url: `${base}/approval`, headers: f.headers, payload: { on: true } })).statusCode).toBe(403);
    expect((await f.post(`${base}/approval`, { on: true, extra: 1 })).statusCode).toBe(400);
    expect((await f.post(`${base}/approval`, { on: "yes" })).statusCode).toBe(400);
    expect((await f.post(`${base}/tools`, { callId: "w1", name: "list_projects", args: {}, userWords: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await f.post(`${base}/tools`, { callId: "w2", name: "list_projects", args: {}, userWords: 5 })).statusCode).toBe(400);

    const refused = (await f.post(`${base}/tools`, { callId: "a1", name: "approve_session", args: { on: true } })).json();
    expect(refused.ok).toBe(false);
    expect(refused.ui.offerApproval).toBe(true);
    const doc = (await f.post(`${base}/tools`, { callId: "a2", name: "approve_session", args: { on: true }, userWords: "did the client approve it?" })).json();
    expect(doc.ok).toBe(false);
    const granted = (await f.post(`${base}/tools`, { callId: "a3", name: "approve_session", args: { on: true }, userWords: "You have my approval" })).json();
    expect(granted.ok).toBe(true);
    const run = (await f.post(`${base}/tools`, { callId: "a4", name: "set_priority", args: { project: "acme", priority: 2 } })).json();
    expect(run.confirm).toBeUndefined();
    expect(JSON.parse(run.output).autoApproved).toBe(true);
    const off = (await f.post(`${base}/tools`, { callId: "a5", name: "approve_session", args: { on: false } })).json();
    expect(off.ok).toBe(true);
    expect(JSON.parse((await f.post(`${base}/tools`, { callId: "a6", name: "set_priority", args: { project: "acme", priority: 3 } })).body).confirm).toBeTruthy();

    const button = await f.post(`${base}/approval`, { on: true });
    expect(button.statusCode).toBe(200);
    expect(button.json()).toMatchObject({ on: true, via: "button" });
    expect((await f.post(`${base}/end`, { reason: "user", transcript: [] })).statusCode).toBe(200);
    expect((await f.post(`${base}/approval`, { on: false })).statusCode).toBe(404);
    const s2 = (await f.post("/api/voice/sessions", start)).json();
    const fresh = (await f.post(`/api/voice/sessions/${s2.sessionId}/tools`, { callId: "b1", name: "set_priority", args: { project: "acme", priority: 4 } })).json();
    expect(fresh.confirm).toBeTruthy();
  });
});
