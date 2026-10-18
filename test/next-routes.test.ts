import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { localBrowserOrigins, registerRequestGuard } from "../src/server/request-guard.ts";
import { registerNextRoutes } from "../src/server/next-routes.ts";
import { createNextService } from "../src/intel/next.ts";
import { intelHarness } from "./intel-fixture.ts";
import { fakeLedger, fakeMeetings } from "./intel-prepare-fixture.ts";

const apps: FastifyInstance[] = []; const hs: ReturnType<typeof intelHarness>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); for (const h of hs.splice(0)) h.close(); });

async function fixture() {
  const h = intelHarness(); hs.push(h);
  h.intel.putOutcome("p1", { desiredOutcome: "Acme staff book online", acceptanceCriteria: [] });
  h.intel.addFinishLineItems("p1", [{ title: "Online booking form" }]);
  const next = createNextService({ db: h.db, intel: h.intel, meetings: fakeMeetings(), work: { progress: () => [] }, ledger: fakeLedger().ledger, now: () => new Date("2026-10-12T09:00:00.000Z") });
  const app = Fastify();
  registerRequestGuard(app, localBrowserOrigins(4317));
  registerNextRoutes(app, next);
  apps.push(app);
  const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string | undefined;
  const post = (url: string, payload: object, csrf = token) => app.inject({ method: "POST", url, headers: { ...headers, ...(csrf ? { "x-dave-csrf": csrf } : {}) }, payload });
  return { app, h, headers, get: (url: string) => app.inject({ url, headers }), post, token };
}

describe("next routes", () => {
  it("guards origin and CSRF", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/intel/next" })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/intel/briefing", headers: { host: "localhost:4317", origin: "http://evil.test" } })).statusCode).toBe(403);
    const id = (await f.get("/api/intel/next")).json().action.id as string;
    expect((await f.app.inject({ method: "POST", url: `/api/intel/next/${id}/act`, headers: f.headers, payload: { op: "copy" } })).statusCode).toBe(403);
  });

  it("serves next and acts; refuses hand_to_ezcoder, stale ids and bad bodies", async () => {
    const f = await fixture();
    const state = (await f.get("/api/intel/next")).json();
    expect(state.queue.length).toBeGreaterThan(0);
    expect(state.action).toEqual(state.queue[0]);
    const build = state.queue.find((a: { kind: string }) => a.kind === "build");
    const refused = await f.post(`/api/intel/next/${build.id}/act`, { op: "hand_to_ezcoder" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("Pew starts EZ Coder after you say yes; DAVE never starts work");
    expect((await f.post("/api/intel/next/0123456789abcdef/act", { op: "copy" })).statusCode).toBe(409);
    expect((await f.post("/api/intel/next/NOTHEX/act", { op: "copy" })).statusCode).toBe(400);
    expect((await f.post(`/api/intel/next/${build.id}/act`, { op: "bogus" })).statusCode).toBe(400);
    expect((await f.post(`/api/intel/next/${build.id}/act`, { op: "copy", extra: 1 })).statusCode).toBe(400);
    expect((await f.post(`/api/intel/next/${build.id}/act`, { op: "skip", note: "x".repeat(501) })).statusCode).toBe(400);
    expect((await f.post(`/api/intel/next/${build.id}/act`, { op: "defer", date: "2026-02-31" })).statusCode).toBe(400);
    expect((await f.post(`/api/intel/next/${build.id}/act`, { op: "mark_demo" })).statusCode).toBe(400);
    const ok = await f.post(`/api/intel/next/${build.id}/act`, { op: "skip", note: "Not today" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, op: "skip", actionId: build.id });
  });

  it("briefing validates caller and since; caller writes the cursor", async () => {
    const f = await fixture();
    expect((await f.get("/api/intel/briefing?caller=bogus")).statusCode).toBe(400);
    expect((await f.get("/api/intel/briefing?since=yesterday")).statusCode).toBe(400);
    expect((await f.get("/api/intel/briefing?other=1")).statusCode).toBe(400);
    const none = await f.get("/api/intel/briefing");
    expect(none.statusCode).toBe(200);
    expect(f.h.db.prepare("SELECT COUNT(*) AS n FROM briefing_cursors").get()).toEqual({ n: 0 });
    const pew = (await f.get("/api/intel/briefing?caller=pew")).json();
    expect(pew).toMatchObject({ sinceSource: "default_24h" });
    expect((await f.get("/api/intel/briefing?caller=pew")).json()).toMatchObject({ sinceSource: "last_asked", since: "2026-10-12T09:00:00.000Z" });
    expect((await f.get("/api/intel/briefing?caller=pew&since=2026-10-11T00:00:00Z")).json()).toMatchObject({ sinceSource: "explicit" });
  });
});
