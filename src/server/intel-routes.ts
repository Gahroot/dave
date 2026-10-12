import type { FastifyInstance, FastifyReply } from "fastify";
import { IntelError, EVIDENCE_STATES, ITEM_KINDS, ITEM_STATUSES, OWNERS, type IntelService, type ItemFields } from "../intel/service.ts";
import { DELIVERY_STAGES, READINESS_LEVELS, type DeliveryStage, type ItemKind, type Owner, type ReadinessLevel } from "../intel/types.ts";
import { strictObject } from "./provider-routes.ts";

const bad = (message = "Invalid request"): never => { throw new IntelError("invalid", message); };
const ID = /^[a-f0-9]{16}$/;
const PROJECT = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown, max: number, min = 1): string {
  if (typeof v !== "string") return bad();
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : bad();
}
function list(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v) || v.length > maxItems) return bad();
  return v.map((x) => text(x, maxLen));
}
function date(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return bad();
  return v;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : bad();
}
function body(req: { body: unknown }, required: string[], optional: string[] = []): Record<string, unknown> {
  const b = req.body ?? {};
  try { strictObject(b, required, optional); } catch { return bad(); }
  return b as Record<string, unknown>;
}

export function registerIntelRoutes(app: FastifyInstance, intel: IntelService) {
  function fail(error: unknown, reply: FastifyReply) {
    if (error instanceof IntelError) return reply.code(error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400).send({ error: error.message });
    throw error;
  }
  const project = (id: string): string => (PROJECT.test(id) ? id : bad("Invalid project id"));
  const hex = (id: string): string => (ID.test(id) ? id : bad("Invalid id"));

  app.get("/api/intel/focus", async () => intel.focus());

  app.get<{ Params: { id: string } }>("/api/intel/projects/:id", async (req, reply) => {
    try { return intel.projectIntel(project(req.params.id)); } catch (e) { return fail(e, reply); }
  });

  app.post("/api/intel/reconcile", async (req, reply) => {
    try {
      const b = body(req, [], ["projectId"]);
      let projectId: string | undefined;
      if (b.projectId !== undefined) {
        projectId = project(String(b.projectId));
        if (!intel.knownProject(projectId)) throw new IntelError("not-found", "Unknown project");
      }
      await intel.reconcile(projectId);
      return intel.focus();
    } catch (e) { return fail(e, reply); }
  });

  app.put<{ Params: { id: string } }>("/api/intel/projects/:id/outcome", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["desiredOutcome", "acceptanceCriteria"], ["stage", "lock"]);
      const stage = b.stage === undefined ? undefined : oneOf<DeliveryStage>(b.stage, DELIVERY_STAGES);
      if (b.lock !== undefined && typeof b.lock !== "boolean") bad();
      return intel.putOutcome(id, { desiredOutcome: text(b.desiredOutcome, 1000), acceptanceCriteria: list(b.acceptanceCriteria, 20, 500), ...(stage ? { stage } : {}), ...(b.lock !== undefined ? { lock: b.lock as boolean } : {}) });
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/items", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["kind", "title"], ["detail", "dueDate", "owner", "acceptance", "dependsOn"]);
      return intel.addItem(id, {
        kind: oneOf<ItemKind>(b.kind, ITEM_KINDS), title: text(b.title, 300),
        ...(b.detail !== undefined ? { detail: b.detail === null ? null : text(b.detail, 2000) } : {}),
        ...(b.dueDate !== undefined ? { dueDate: date(b.dueDate) } : {}),
        ...(b.owner !== undefined ? { owner: oneOf<Owner>(b.owner, OWNERS) } : {}),
        ...(b.acceptance !== undefined ? { acceptance: list(b.acceptance, 12, 400) } : {}),
        ...(b.dependsOn !== undefined ? { dependsOn: list(b.dependsOn, 20, 16).map(hex) } : {}),
      });
    } catch (e) { return fail(e, reply); }
  });

  app.patch<{ Params: { itemId: string } }>("/api/intel/items/:itemId", async (req, reply) => {
    try {
      const id = hex(req.params.itemId);
      const b = body(req, [], ["title", "detail", "status", "evidenceState", "owner", "dueDate", "acceptance", "locked", "readinessReached", "confirm"]);
      const f: ItemFields = {};
      if (b.title !== undefined) f.title = text(b.title, 300);
      if (b.detail !== undefined) f.detail = b.detail === null ? null : text(b.detail, 2000);
      if (b.status !== undefined) f.status = oneOf(b.status, ITEM_STATUSES);
      if (b.evidenceState !== undefined) f.evidenceState = oneOf(b.evidenceState, EVIDENCE_STATES);
      if (b.owner !== undefined) f.owner = oneOf<Owner>(b.owner, OWNERS);
      if (b.dueDate !== undefined) f.dueDate = date(b.dueDate);
      if (b.acceptance !== undefined) f.acceptance = list(b.acceptance, 12, 400);
      if (b.locked !== undefined) { if (typeof b.locked !== "boolean") bad(); f.locked = b.locked as boolean; }
      if (b.confirm !== undefined) { if (typeof b.confirm !== "boolean") bad(); f.confirm = b.confirm as boolean; }
      if (b.readinessReached !== undefined) f.readinessReached = b.readinessReached === null ? null : oneOf<ReadinessLevel>(b.readinessReached, READINESS_LEVELS);
      return intel.patchItem(id, f);
    } catch (e) { return fail(e, reply); }
  });

  for (const action of ["accept", "reject"] as const) {
    app.post<{ Params: { id: string } }>(`/api/intel/proposals/:id/${action}`, async (req, reply) => {
      try {
        const id = hex(req.params.id);
        const b = body(req, [], ["note"]);
        const note = b.note === undefined || b.note === null ? null : text(b.note, 500);
        return intel.resolveProposal(id, action === "accept", note);
      } catch (e) { return fail(e, reply); }
    });
  }

  app.get<{ Params: { id: string } }>("/api/intel/objectives/:id/brief", async (req, reply) => {
    try {
      const id = hex(req.params.id);
      if (!intel.objectiveExists(id)) throw new IntelError("not-found", "Unknown objective");
      const brief = intel.brief(id);
      if (brief === null) throw new IntelError("not-found", "This objective needs a human step; there is no coding brief");
      return { brief };
    } catch (e) { return fail(e, reply); }
  });
}
