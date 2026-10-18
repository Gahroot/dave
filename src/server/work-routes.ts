import type { FastifyInstance } from "fastify";
import { strictObject } from "./provider-routes.ts";
import type { WorkService } from "../work/service.ts";
import type { WorkQuery } from "../work/store.ts";

const bad = (): Error => Object.assign(new Error("Invalid request"), { statusCode: 400 });
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseQuery(value: unknown): WorkQuery {
  const q = value ?? {};
  strictObject(q, [], ["since", "projectId", "limit"]);
  const out: WorkQuery = {};
  if (q.since !== undefined) {
    if (typeof q.since !== "string" || q.since.length > 40 || !Number.isFinite(Date.parse(q.since))) throw bad();
    out.since = new Date(Date.parse(q.since)).toISOString();
  }
  if (q.projectId !== undefined) { if (typeof q.projectId !== "string" || !PROJECT_ID.test(q.projectId)) throw bad(); out.projectId = q.projectId; }
  if (q.limit !== undefined) {
    if (typeof q.limit !== "string" || !/^\d{1,3}$/.test(q.limit)) throw bad();
    const n = Number(q.limit);
    if (n < 1 || n > 100) throw bad();
    out.limit = n;
  }
  return out;
}

/** Completion loop routes, under the guarded /api/intel prefix. Read-only except the GitHub switch and a manual poll. */
export function registerWorkRoutes(app: FastifyInstance, work: WorkService): void {
  app.get("/api/intel/work/events", async (req) => ({ events: work.events(parseQuery(req.query)) }));
  app.get("/api/intel/work/progress", async (req) => ({ reports: work.progress(parseQuery(req.query)) }));
  app.get("/api/intel/work/settings", async () => work.settings());
  app.post("/api/intel/work/settings", async (req) => {
    strictObject(req.body, ["github"]);
    if (typeof req.body.github !== "boolean") throw bad();
    return work.setSettings({ github: req.body.github });
  });
  app.post("/api/intel/work/poll", async (req) => {
    strictObject(req.body, []);
    return work.poll();
  });
}
