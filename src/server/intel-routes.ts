import type { FastifyInstance, FastifyReply } from "fastify";
import { IntelError, EVIDENCE_STATES, ITEM_KINDS, ITEM_STATUSES, MAX_ACCEPTANCE_CRITERIA, MAX_FOCUS_ITEMS, OWNERS, type FinishLineInput, type IntelService, type ItemFields } from "../intel/service.ts";
import { DIRECTION_NOTE_MAX_CHARS, PRIORITY_MAX, PRIORITY_MIN, type DirectionPatch, DELIVERY_STAGES, LANES, MARKABLE_STEPS, READINESS_LEVELS, type DeliveryStage, type ItemKind, type Lane, type MarkableStep, type Owner, type ReadinessLevel } from "../intel/types.ts";
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
function shape(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  try { strictObject(v, required, optional); } catch { return bad(); }
  return v;
}
function body(req: { body: unknown }, required: string[], optional: string[] = []): Record<string, unknown> {
  return shape(req.body ?? {}, required, optional);
}
function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : bad();
}
function nullableText(v: unknown, max: number): string | null {
  return v === null ? null : text(v, max);
}
const MAX_FINISH_LINE_ITEMS = 50;
const MAX_SENT_IDS = 100;
function finishLineItems(v: unknown): FinishLineInput[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_FINISH_LINE_ITEMS) return bad();
  return v.map((raw) => {
    const e = shape(raw, ["title"], ["detail", "acceptance", "goal"]);
    return {
      title: text(e.title, 300),
      ...(e.detail !== undefined ? { detail: nullableText(e.detail, 2000) } : {}),
      ...(e.acceptance !== undefined ? { acceptance: list(e.acceptance, 12, 400) } : {}),
      ...(e.goal !== undefined ? { goal: nullableText(e.goal, 300) } : {}),
    };
  });
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
      const b = body(req, ["desiredOutcome", "acceptanceCriteria"], ["stage", "lock", "targetDate", "startDate"]);
      const stage = b.stage === undefined ? undefined : oneOf<DeliveryStage>(b.stage, DELIVERY_STAGES);
      return intel.putOutcome(id, {
        desiredOutcome: text(b.desiredOutcome, 1000), acceptanceCriteria: list(b.acceptanceCriteria, MAX_ACCEPTANCE_CRITERIA, 500),
        ...(stage ? { stage } : {}), ...(b.lock !== undefined ? { lock: bool(b.lock) } : {}),
        ...(b.targetDate !== undefined ? { targetDate: date(b.targetDate) } : {}),
        ...(b.startDate !== undefined ? { startDate: date(b.startDate) } : {}),
      });
    } catch (e) { return fail(e, reply); }
  });

  app.put<{ Params: { id: string } }>("/api/intel/projects/:id/schedule", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["targetDate"], ["startDate"]);
      return intel.setSchedule(id, { targetDate: date(b.targetDate), ...(b.startDate !== undefined ? { startDate: date(b.startDate) } : {}) });
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/steps", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["step", "reached"]);
      return intel.setStep(id, oneOf<MarkableStep>(b.step, MARKABLE_STEPS), bool(b.reached));
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/demo", async (req, reply) => {
    try {
      const id = project(req.params.id);
      body(req, []);
      return intel.markDemo(id);
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/tasks/sent", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["itemIds", "sent"]);
      const ids = list(b.itemIds, MAX_SENT_IDS, 16).map(hex);
      if (!ids.length) bad();
      return intel.markSent(id, ids, bool(b.sent));
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/finish-line", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["items"], ["acceptance"]);
      const items = finishLineItems(b.items);
      const acceptance = b.acceptance === undefined ? [] : list(b.acceptance, MAX_ACCEPTANCE_CRITERIA, 500);
      return intel.addFinishLineItems(id, items, acceptance);
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
      const b = body(req, [], ["title", "detail", "status", "evidenceState", "owner", "dueDate", "acceptance", "locked", "readinessReached", "confirm", "lane", "goal"]);
      const f: ItemFields = {};
      if (b.title !== undefined) f.title = text(b.title, 300);
      if (b.detail !== undefined) f.detail = b.detail === null ? null : text(b.detail, 2000);
      if (b.status !== undefined) f.status = oneOf(b.status, ITEM_STATUSES);
      if (b.evidenceState !== undefined) f.evidenceState = oneOf(b.evidenceState, EVIDENCE_STATES);
      if (b.owner !== undefined) f.owner = oneOf<Owner>(b.owner, OWNERS);
      if (b.dueDate !== undefined) f.dueDate = date(b.dueDate);
      if (b.acceptance !== undefined) f.acceptance = list(b.acceptance, 12, 400);
      if (b.locked !== undefined) f.locked = bool(b.locked);
      if (b.confirm !== undefined) f.confirm = bool(b.confirm);
      if (b.readinessReached !== undefined) f.readinessReached = b.readinessReached === null ? null : oneOf<ReadinessLevel>(b.readinessReached, READINESS_LEVELS);
      if (b.lane !== undefined) f.lane = b.lane === null ? null : oneOf<Lane>(b.lane, LANES);
      if (b.goal !== undefined) f.goal = nullableText(b.goal, 300);
      return intel.patchItem(id, f);
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { itemId: string } }>("/api/intel/items/:itemId/verify", async (req, reply) => {
    try {
      const id = hex(req.params.itemId);
      body(req, []);
      return intel.verifyItem(id);
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { itemId: string } }>("/api/intel/items/:itemId/reopen", async (req, reply) => {
    try {
      const id = hex(req.params.itemId);
      const b = body(req, [], ["note"]);
      return intel.reopenItem(id, b.note === undefined || b.note === null ? null : text(b.note, 500));
    } catch (e) { return fail(e, reply); }
  });

  for (const action of ["accept", "reject"] as const) {
    app.post<{ Params: { id: string } }>(`/api/intel/proposals/:id/${action}`, async (req, reply) => {
      try {
        const id = hex(req.params.id);
        const b = body(req, [], action === "accept" ? ["note", "lane"] : ["note"]);
        const note = b.note === undefined || b.note === null ? null : text(b.note, 500);
        const lane = b.lane === undefined ? undefined : oneOf<Lane>(b.lane, LANES);
        return intel.resolveProposal(id, action === "accept", note, lane);
      } catch (e) { return fail(e, reply); }
    });
  }

  app.put<{ Params: { id: string } }>("/api/intel/projects/:id/direction", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, [], ["paidWhen", "priority", "focusItemIds"]);
      if (b.paidWhen === undefined && b.priority === undefined && b.focusItemIds === undefined) bad("Nothing to change");
      const patch: DirectionPatch = {};
      if (b.paidWhen !== undefined) patch.paidWhen = b.paidWhen === null ? null : text(b.paidWhen, DIRECTION_NOTE_MAX_CHARS, 0);
      if (b.priority !== undefined) {
        if (b.priority !== null && (typeof b.priority !== "number" || !Number.isInteger(b.priority) || b.priority < PRIORITY_MIN || b.priority > PRIORITY_MAX)) bad("Invalid priority");
        patch.priority = b.priority === null ? null : Number(b.priority);
      }
      if (b.focusItemIds !== undefined) patch.focusItemIds = list(b.focusItemIds, MAX_FOCUS_ITEMS, 16).map(hex);
      return intel.setDirection(id, patch);
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/projects/:id/notes", async (req, reply) => {
    try {
      const id = project(req.params.id);
      const b = body(req, ["text"]);
      const note = intel.addDirectionNote(id, text(b.text, DIRECTION_NOTE_MAX_CHARS), "ui");
      return { note, intel: intel.projectIntel(id) };
    } catch (e) { return fail(e, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/intel/notes/:id/delete", async (req, reply) => {
    try {
      const id = hex(req.params.id);
      body(req, []);
      intel.deleteDirectionNote(id);
      return { ok: true };
    } catch (e) { return fail(e, reply); }
  });

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
