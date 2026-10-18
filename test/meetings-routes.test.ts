import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore, type FathomKeyStore } from "../src/meetings/credentials.ts";
import { tempDir } from "./helpers.ts";

const KEY = "fathom-route-key-0123456789abcdef";
const T0 = new Date("2026-09-30T12:00:00.000Z");
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const MEETING = {
  title: "Acme weekly", meeting_title: null, recording_id: 4242, url: "https://fathom.video/calls/4242", share_url: null,
  created_at: "2026-09-29T10:00:00Z", recording_start_time: "2026-09-29T09:00:00Z", recording_end_time: "2026-09-29T10:00:00Z",
  calendar_invitees_domains_type: "one_or_more_external",
  calendar_invitees: [{ name: "Jane", email: "jane@acme.com", email_domain: "acme.com", is_external: true, matched_speaker_display_name: null }],
  recorded_by: { name: "Dave", email: "dave@studio.dev", email_domain: "studio.dev" },
};

const apps: FastifyInstance[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

async function fixture(options: { keyStore?: FathomKeyStore; status?: number } = {}) {
  const home = tempDir("meeting-routes-"); homes.push(home);
  const calls: { url: URL; key: string | undefined }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, key: (init?.headers as Record<string, string> | undefined)?.["X-Api-Key"] });
    if (options.status) return new Response(JSON.stringify({ error: "nope" }), { status: options.status });
    if (url.pathname.endsWith("/transcript")) {
      return Response.json({ transcript: [{ speaker: { display_name: "Jane", matched_calendar_invitee_email: "jane@acme.com" }, text: `SECRET-TRANSCRIPT ${words(60)}`, timestamp: "00:00:10" }] });
    }
    return Response.json({ limit: null, next_cursor: null, items: url.searchParams.has("recorded_by[]") ? [MEETING] : [] });
  }) as typeof globalThis.fetch;
  const keyStore = options.keyStore ?? memoryKeyStore();
  const modelCalls: string[] = [];
  const answer = JSON.stringify({ summary: { headline: "Weekly", overview: "o", direction: [] }, my_commitments: [], client_suggestions: [], client_pain_points: [], decisions: [], status_updates: [] });
  // A fake model: route tests never reach the real provider or its Keychain entry.
  const app = await buildServer(sourcePaths(home, home), { meetings: {
    keyStore, fetch: fakeFetch, now: () => T0, openAIConnected: () => false,
    inference: async req => { modelCalls.push(req.user); return answer; },
  } });
  apps.push(app);
  const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const seen: string[] = [];
  const record = (r: LightMyRequestResponse) => { seen.push(r.body); return r; };
  return {
    app, calls, keyStore, seen, headers, modelCalls,
    get: async (url: string) => record(await app.inject({ url, headers })),
    post: async (url: string, payload: unknown) => record(await app.inject({ method: "POST", url, headers: { ...headers, "x-dave-csrf": token }, payload: payload as object })),
    async idle() {
      for (let i = 0; i < 100; i++) {
        const s = (await app.inject({ url: "/api/meetings/status", headers })).json();
        if (!s.sync.running && s.analysis.running === null && s.analysis.queued.length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error("sync or analysis did not finish");
    },
  };
}

describe("meeting routes", () => {
  it("applies the browser request guard to every meeting route", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/meetings/status" })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/meetings/status", headers: { host: "localhost:4317", origin: "https://evil.test" } })).statusCode).toBe(403);
    // No CSRF token: refused before the key reaches any handler or storage.
    const noToken = await f.app.inject({ method: "POST", url: "/api/meetings/key", headers: f.headers, payload: { key: KEY } });
    expect(noToken.statusCode).toBe(403);
    expect(f.keyStore.read()).toBeNull();
    expect(noToken.body).not.toContain(KEY);
    expect(f.calls).toHaveLength(0);
  });

  it("saves and proves the key without ever returning it", async () => {
    const f = await fixture();
    expect((await f.get("/api/meetings/status")).json()).toMatchObject({ key: { saved: false, state: "unknown" }, settings: { autoExtract: false, connectedAt: null } });
    expect((await f.post("/api/meetings/key", { key: "whsec_0123456789abcdefghijklmnop" })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/key", { key: KEY, extra: 1 })).statusCode).toBe(400);
    const saved = await f.post("/api/meetings/key", { key: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ key: { saved: true, state: "valid" }, settings: { connectedAt: T0.toISOString() } });
    expect(f.keyStore.read()).toBe(KEY);
    // One light call, with the key only in the header.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.key).toBe(KEY);
    expect(f.calls[0]!.url.searchParams.has("recorded_by[]")).toBe(false);
    // A malformed body carrying the key is not echoed back.
    const garbled = await f.app.inject({ method: "POST", url: "/api/meetings/key", headers: { ...f.headers, "x-dave-csrf": (await f.app.inject({ url: "/api/security/csrf", headers: f.headers })).json().token, "content-type": "application/json" }, payload: `{"key":"${KEY}"` });
    expect(garbled.statusCode).toBe(400);
    f.seen.push(garbled.body);
    for (const body of f.seen) expect(body).not.toContain(KEY);
  });

  it("reports a key Fathom rejects and keeps DAVE disconnected", async () => {
    const f = await fixture({ status: 401 });
    const saved = await f.post("/api/meetings/key", { key: KEY });
    expect(saved.statusCode).toBe(400);
    expect(saved.json().error).toContain("Fathom rejected");
    expect(saved.body).not.toContain(KEY);
    expect((await f.get("/api/meetings/status")).json()).toMatchObject({ key: { saved: true, state: "invalid" }, settings: { connectedAt: null } });
  });

  it("validates settings strictly", async () => {
    const f = await fixture();
    expect((await f.post("/api/meetings/settings", { unknown: true })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/settings", { fathomEmail: "not-an-email" })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/settings", { historyDays: 45 })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/settings", { nameAliases: Array.from({ length: 9 }, (_, i) => `n${i}`) })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/settings", { paused: "yes" })).statusCode).toBe(400);
    const ok = await f.post("/api/meetings/settings", { fathomEmail: " Dave@Studio.dev ", nameAliases: ["Dave O.", "dave o."], historyDays: 7, ignoreWords: ["Standup"], paused: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ fathomEmail: "dave@studio.dev", nameAliases: ["Dave O."], historyDays: 7, ignoreWords: ["Standup"] });
  });

  it("syncs on request, lists and shows meetings without transcripts, forgets and disconnects", async () => {
    const f = await fixture();
    expect((await f.post("/api/meetings/sync", {})).statusCode).toBe(409);
    await f.post("/api/meetings/key", { key: KEY });
    expect((await f.post("/api/meetings/sync", {})).statusCode).toBe(409);
    await f.post("/api/meetings/settings", { fathomEmail: "dave@studio.dev" });
    expect((await f.post("/api/meetings/sync", {})).statusCode).toBe(202);
    await f.idle();

    const list = await f.get("/api/meetings/recordings");
    expect(list.json().meetings).toMatchObject([{ recordingId: "4242", title: "Acme weekly", status: "imported" }]);
    expect((await f.get("/api/meetings/recordings/4242")).json()).toMatchObject({ recordingId: "4242", items: [], summary: null });
    expect((await f.get("/api/meetings/recordings/nope")).statusCode).toBe(404);
    expect((await f.get("/api/meetings/recordings/999")).statusCode).toBe(404);
    const status = (await f.get("/api/meetings/status")).json();
    expect(status.sync).toMatchObject({ running: false, lastSuccessAt: T0.toISOString(), keyState: "valid" });
    expect(status.sync).not.toHaveProperty("cursor");
    expect(status.runs[0]).toMatchObject({ trigger: "manual", outcome: "ok", stats: { added: 1, transcripts: 1 } });

    // Analysis needs consent to the disclosure the server currently shows.
    const version = status.analysis.disclosure.version as string;
    expect(status.analysis).toMatchObject({ on: false, openAIConnected: false, running: null, queued: [] });
    expect(status.analysis.disclosure.sections[0].items.join(" ")).toContain("transcript");
    expect((await f.post("/api/meetings/analysis", { on: true })).statusCode).toBe(409);
    expect((await f.post("/api/meetings/analysis", { on: true, consentVersion: "old" })).statusCode).toBe(409);
    expect((await f.post("/api/meetings/analysis", { on: "yes", consentVersion: version })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/recordings/4242/analyze", {})).statusCode).toBe(409);
    expect((await f.post("/api/meetings/recordings/4242/analyze", { consentVersion: version, extra: 1 })).statusCode).toBe(400);
    expect(f.modelCalls).toHaveLength(0);
    expect((await f.post("/api/meetings/recordings/4242/analyze", { consentVersion: version })).statusCode).toBe(202);
    await f.idle();
    expect(f.modelCalls).toHaveLength(1);
    expect(f.modelCalls[0]).toContain("SECRET-TRANSCRIPT");
    expect((await f.get("/api/meetings/recordings/4242")).json()).toMatchObject({ status: "analyzed", summary: { headline: "Weekly" } });
    const on = await f.post("/api/meetings/analysis", { on: true, consentVersion: version });
    expect(on.json().analysis).toMatchObject({ on: true });
    expect((await f.post("/api/meetings/analysis", { on: false })).json().analysis).toMatchObject({ on: false });
    expect((await f.post("/api/meetings/recordings/4242/retry", {})).statusCode).toBe(409);

    // Item routes reject malformed and unknown ids before touching storage.
    expect((await f.get("/api/meetings/items/not-an-item/assignment")).statusCode).toBe(404);
    expect((await f.get("/api/meetings/items/mi-ffffffffffffffffffffffff/assignment")).statusCode).toBe(404);
    expect((await f.post("/api/meetings/items/mi-ffffffffffffffffffffffff/status", { action: "done" })).statusCode).toBe(404);
    expect((await f.post("/api/meetings/items/mi-ffffffffffffffffffffffff/status", {})).statusCode).toBe(400);
    expect((await f.post("/api/meetings/items/mi-ffffffffffffffffffffffff/strength", { strength: "firm" })).statusCode).toBe(404);
    expect((await f.post("/api/meetings/items/not-an-item/strength", { strength: "firm" })).statusCode).toBe(404);
    expect((await f.post("/api/meetings/items/mi-ffffffffffffffffffffffff/strength", { strength: "firm", extra: 1 })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/items/mi-ffffffffffffffffffffffff/strength", {})).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/meetings/items/mi-ffffffffffffffffffffffff/strength", headers: f.headers, payload: { strength: "firm" } })).statusCode).toBe(403);

    expect((await f.post("/api/meetings/recordings/4242/forget", { extra: 1 })).statusCode).toBe(400);
    expect((await f.post("/api/meetings/recordings/4242/forget", {})).statusCode).toBe(200);
    expect((await f.post("/api/meetings/recordings/4242/forget", {})).statusCode).toBe(404);
    expect((await f.get("/api/meetings/recordings")).json().meetings).toEqual([]);

    expect((await f.post("/api/meetings/disconnect", {})).statusCode).toBe(400);
    const off = await f.post("/api/meetings/disconnect", { deleteMeetings: true });
    expect(off.json()).toMatchObject({ key: { saved: false }, settings: { connectedAt: null, autoExtract: false } });
    expect(f.keyStore.read()).toBeNull();
    for (const body of f.seen) { expect(body).not.toContain(KEY); expect(body).not.toContain("SECRET-TRANSCRIPT"); }
  });
});
