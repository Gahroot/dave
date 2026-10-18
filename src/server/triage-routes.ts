import type { FastifyInstance } from "fastify";
import { strictObject } from "./provider-routes.ts";
import type { TriageService } from "../triage/service.ts";
import {
  MAX_APPLY_KEYS, TRIAGE_ACTIONS, TRIAGE_BATCH_ID, TRIAGE_BUCKETS, TRIAGE_KEY, TRIAGE_KINDS,
  type TriageAction, type TriageBucket, type TriageFilter, type TriageKind,
} from "../triage/types.ts";

const FILTER_FIELDS = ["buckets", "projectId", "kinds", "olderThanDays", "overdueOnly", "includeConfirmed", "text", "keys"];
const bad = (): Error => Object.assign(new Error("Invalid request"), { statusCode: 400 });

function list<T extends string>(v: unknown, allowed: readonly T[], max: number): T[] {
  if (!Array.isArray(v) || v.length > max) throw bad();
  return v.map((x) => { const hit = allowed.find((a) => a === x); if (!hit) throw bad(); return hit; });
}
function keys(v: unknown, min: number): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > MAX_APPLY_KEYS) throw bad();
  return v.map((k) => { if (typeof k !== "string" || !TRIAGE_KEY.test(k)) throw bad(); return k; });
}
function bool(v: unknown): boolean { if (typeof v !== "boolean") throw bad(); return v; }
function shortText(v: unknown): string { if (typeof v !== "string" || v.length > 200) throw bad(); return v; }

export function parseFilter(value: unknown): TriageFilter {
  if (value === undefined) return {};
  strictObject(value, [], FILTER_FIELDS);
  const f: TriageFilter = {};
  if (value.buckets !== undefined) f.buckets = list<TriageBucket>(value.buckets, TRIAGE_BUCKETS, TRIAGE_BUCKETS.length);
  if (value.kinds !== undefined) f.kinds = list<TriageKind>(value.kinds, TRIAGE_KINDS, TRIAGE_KINDS.length);
  if (value.projectId !== undefined) { const p = shortText(value.projectId); if (!p) throw bad(); f.projectId = p; }
  if (value.olderThanDays !== undefined) {
    const d = value.olderThanDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 3650) throw bad();
    f.olderThanDays = d;
  }
  if (value.overdueOnly !== undefined) f.overdueOnly = bool(value.overdueOnly);
  if (value.includeConfirmed !== undefined) f.includeConfirmed = bool(value.includeConfirmed);
  if (value.text !== undefined) f.text = shortText(value.text);
  if (value.keys !== undefined) f.keys = keys(value.keys, 0);
  return f;
}

export function registerTriageRoutes(app: FastifyInstance, triage: TriageService): void {
  app.post("/api/triage/preview", async (req) => {
    const body = req.body ?? {};
    strictObject(body, [], ["filter"]);
    return triage.preview(parseFilter(body.filter));
  });
  app.post("/api/triage/apply", async (req) => {
    strictObject(req.body, ["keys", "action"]);
    const wanted = req.body.action;
    const action = TRIAGE_ACTIONS.find((a): a is TriageAction => a === wanted);
    if (!action) throw bad();
    return triage.apply({ keys: keys(req.body.keys, 1), action, source: "ui" });
  });
  app.post("/api/triage/undo", async (req, reply) => {
    strictObject(req.body, ["batchId"]);
    const id = req.body.batchId;
    if (typeof id !== "string" || !TRIAGE_BATCH_ID.test(id)) throw bad();
    const result = triage.undo(id);
    return result ?? reply.code(404).send({ error: "Unknown clean-up" });
  });
  app.get("/api/triage/batches", async () => ({ batches: triage.batches() }));
}
