import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWorkRoutes } from "../src/server/work-routes.ts";
import type { WorkService } from "../src/work/service.ts";
import type { WorkSettingsView } from "../src/work/types.ts";

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function fake() {
  const calls: string[] = [];
  let github = false;
  const view = (): WorkSettingsView => ({ githubEnabled: github, githubConsentedAt: null, updatedAt: null, sources: [] });
  const work: WorkService = {
    poll: async () => { calls.push("poll"); return { events: 0, reports: 0, projects: 0 }; },
    workEvidence: () => [],
    progress: (q) => { calls.push(`progress:${JSON.stringify(q)}`); return []; },
    events: (q) => { calls.push(`events:${JSON.stringify(q)}`); return []; },
    settings: view,
    setSettings: ({ github: g }) => { github = g; return view(); },
    onProgress: () => () => undefined,
    start: () => undefined,
    close: () => undefined,
  };
  const app = Fastify();
  registerWorkRoutes(app, work);
  apps.push(app);
  return { app, calls };
}

describe("work routes", () => {
  it("serves events, progress and settings, and validates input strictly", async () => {
    const { app, calls } = fake();
    expect((await app.inject({ url: "/api/intel/work/events?limit=5&projectId=p1&since=2026-10-01T00:00:00Z" })).json()).toEqual({ events: [] });
    expect(calls).toContain('events:{"since":"2026-10-01T00:00:00.000Z","projectId":"p1","limit":5}');
    expect((await app.inject({ url: "/api/intel/work/progress" })).json()).toEqual({ reports: [] });
    for (const bad of ["limit=0", "limit=101", "limit=x", "since=nope", "projectId=../x", "other=1"]) {
      expect((await app.inject({ url: `/api/intel/work/progress?${bad}` })).statusCode).toBe(400);
    }
    expect((await app.inject({ url: "/api/intel/work/settings" })).json()).toMatchObject({ githubEnabled: false });
    expect((await app.inject({ method: "POST", url: "/api/intel/work/settings", payload: { github: true } })).json()).toMatchObject({ githubEnabled: true });
    for (const payload of [{ github: "yes" }, {}, { github: true, extra: 1 }]) {
      expect((await app.inject({ method: "POST", url: "/api/intel/work/settings", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/intel/work/poll", payload: {} })).json()).toEqual({ events: 0, reports: 0, projects: 0 });
    expect((await app.inject({ method: "POST", url: "/api/intel/work/poll", payload: { force: true } })).statusCode).toBe(400);
    expect(calls.filter((c) => c === "poll")).toHaveLength(1);
  });
});
