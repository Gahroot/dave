import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../src/server/routes.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { refresh } from "../src/model/refresh.ts";
import { freshRepo, NOW, tempDir } from "./helpers.ts";

async function fixture() {
  const ctx = freshRepo();
  const paths = sourcePaths(tempDir(), ctx.home);
  let now = new Date(NOW);
  let calls = 0;
  let fail = false;
  const app = Fastify();
  registerRoutes(app, paths, ctx.repo, { clock: () => now, refresh: async (...args) => {
    calls++;
    if (fail) throw new Error("fixture read failed");
    return refresh(...args);
  } });
  const id = ctx.repo.ensureProject("/synthetic", "Synthetic", NOW.toISOString());
  ctx.repo.reconcileAttention([{ projectId: id, subjectKey: "task:1", fingerprint: "revision", kind: "agent-question", title: "Request", detail: "needs your approval", evidence: [], urgency: 100, nextStep: "Inspect request" }], [], NOW.toISOString());
  return { ...ctx, app, calls: () => calls, setNow: (date: Date) => { now = date; }, fail: (value: boolean) => { fail = value; } };
}

describe("attention routes and refresh cache", () => {
  it("coalesces concurrent refreshes, honors TTL, preserves failed snapshots and retries", async () => {
    const f = await fixture();
    try {
      const responses = await Promise.all([1,2,3].map(() => f.app.inject("/api/portfolio")));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(f.calls()).toBe(1);
      await f.app.inject("/api/portfolio");
      expect(f.calls()).toBe(1);
      f.setNow(new Date(NOW.getTime() + 60_000));
      f.fail(true);
      const failed = (await f.app.inject("/api/portfolio")).json();
      expect(failed.stale).toBe(true);
      expect(failed.generatedAt).toBe(NOW.toISOString());
      expect(failed.inbox).toHaveLength(1);
      f.fail(false);
      const recovered = (await f.app.inject("/api/portfolio")).json();
      expect(recovered.stale).not.toBe(true);
      expect(f.calls()).toBe(3);
    } finally { await f.app.close(); }
  });
  it("validates actions, tracks displayed IDs and evaluates snooze expiry without rescanning", async () => {
    const f = await fixture();
    try {
      const first = (await f.app.inject("/api/portfolio")).json();
      const id = first.inbox[0].id;
      const post = (url: string, payload = {}) => f.app.inject({ method: "POST", url, payload });
      expect((await post(`/api/attention/${id}/execute`)).statusCode).toBe(400);
      expect((await post("/api/attention/unknown/handled")).statusCode).toBe(404);
      expect((await post("/api/attention/seen", { ids: [123] })).statusCode).toBe(400);
      expect((await post("/api/attention/seen", { ids: ["unknown"] })).statusCode).toBe(404);
      expect((await post("/api/attention/seen", { ids: [id] })).statusCode).toBe(200);
      const snoozed = (await post(`/api/attention/${id}/tomorrow`)).json().portfolio;
      expect(snoozed.inbox).toEqual([]);
      expect(snoozed.today).toEqual([]);
      const until = snoozed.history[0].snoozedUntil;
      // Store a fresh snapshot at the deadline to exercise expiry in cached GET.
      f.setNow(new Date(until));
      f.repo.saveSnapshot({ ...snoozed, generatedAt: until });
      expect((await f.app.inject("/api/portfolio")).json().inbox).toHaveLength(1);
      expect(f.calls()).toBe(1);
      expect((await post(`/api/attention/${id}/handled`)).json().portfolio.inbox).toEqual([]);
      expect((await post(`/api/attention/${id}/undo`)).json().portfolio.inbox).toHaveLength(1);
      expect(f.calls()).toBe(1);
    } finally { await f.app.close(); }
  });
});
