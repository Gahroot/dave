import type { FastifyInstance, FastifyReply } from "fastify";
import { strictObject } from "./provider-routes.ts";
import { isRecordingId } from "../meetings/fathom-client.ts";
import { MeetingError, parseSettingsPatch, type MeetingService } from "../meetings/service.ts";

type Params = { id: string };

/**
 * Meetings namespace. Every route sits under /api/meetings, so the request
 * guard applies origin, CSRF, body-size and no-echo error handling to all of them.
 * No route ever returns the Fathom key or a transcript.
 */
export function registerMeetingRoutes(app: FastifyInstance, service: MeetingService): void {
  const handle = async (reply: FastifyReply, fn: () => unknown): Promise<unknown> => {
    try { return await fn(); }
    catch (e) { if (e instanceof MeetingError) return reply.code(e.statusCode).send({ error: e.message }); throw e; }
  };
  const recording = (id: string): string => {
    if (!isRecordingId(id)) throw new MeetingError(404, "Unknown meeting");
    return id;
  };

  app.get("/api/meetings/status", async () => service.status());

  app.post("/api/meetings/key", async (req, reply) => {
    strictObject(req.body, ["key"]);
    const body = req.body;
    return handle(reply, () => service.saveKey(body.key));
  });

  app.post("/api/meetings/disconnect", async (req, reply) => {
    strictObject(req.body, ["deleteMeetings"]);
    const { deleteMeetings } = req.body;
    if (typeof deleteMeetings !== "boolean") return reply.code(400).send({ error: "Choose whether to keep imported meetings" });
    return handle(reply, () => service.disconnect({ deleteMeetings }));
  });

  app.post("/api/meetings/settings", async (req, reply) => {
    strictObject(req.body, [], ["fathomEmail", "nameAliases", "historyDays", "paused", "ignoreWords"]);
    const body = req.body;
    return handle(reply, () => service.updateSettings(parseSettingsPatch(body)));
  });

  app.post("/api/meetings/sync", async (req, reply) => {
    strictObject(req.body, []);
    return handle(reply, () => { const status = service.syncNow(); return reply.code(202).send(status); });
  });

  app.get("/api/meetings/recordings", async () => ({ meetings: service.list() }));

  app.get<{ Params: Params }>("/api/meetings/recordings/:id", async (req, reply) =>
    handle(reply, () => service.detail(recording(req.params.id))));

  app.get("/api/meetings/instructions", async () => service.instructions());

  app.post("/api/meetings/instructions", async (req, reply) => {
    strictObject(req.body, ["instructions"]);
    const { instructions } = req.body;
    return handle(reply, () => service.saveInstructions(instructions));
  });

  app.post("/api/meetings/instructions/reset", async (req, reply) => {
    strictObject(req.body, []);
    return handle(reply, () => service.resetInstructions());
  });

  app.post("/api/meetings/reanalyze", async (req, reply) => {
    strictObject(req.body, [], ["consentVersion"]);
    const { consentVersion } = req.body;
    return handle(reply, () => { const status = service.reanalyzeStale(consentVersion); return reply.code(202).send(status); });
  });

  app.post("/api/meetings/analysis", async (req, reply) => {
    strictObject(req.body, ["on"], ["consentVersion"]);
    const { on, consentVersion } = req.body;
    if (typeof on !== "boolean") return reply.code(400).send({ error: "Choose on or off" });
    return handle(reply, () => service.setAnalysis(on, consentVersion));
  });

  app.post<{ Params: Params }>("/api/meetings/recordings/:id/analyze", async (req, reply) => {
    strictObject(req.body, [], ["consentVersion"]);
    const { consentVersion } = req.body;
    return handle(reply, () => { const status = service.analyze(recording(req.params.id), consentVersion); return reply.code(202).send(status); });
  });

  app.post<{ Params: Params }>("/api/meetings/recordings/:id/retry", async (req, reply) => {
    strictObject(req.body, []);
    return handle(reply, () => service.retry(recording(req.params.id)));
  });

  // Promises and client asks across meetings, for the Meetings page.
  app.get("/api/meetings/items", async () => ({
    promises: service.items({ kinds: ["commitment"], statuses: ["open", "looks_done"] }),
    asks: service.items({ kinds: ["pain_point", "suggestion"], statuses: ["open", "planned", "looks_done"] }),
  }));

  app.get("/api/meetings/projects", async () => ({ projects: service.projectChoices(), rules: service.rules() }));

  app.get<{ Params: Params }>("/api/meetings/projects/:id", async (req, reply) => {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(req.params.id)) return reply.code(404).send({ error: "Unknown project" });
    return handle(reply, () => service.projectOverview(req.params.id));
  });

  app.post<{ Params: Params }>("/api/meetings/recordings/:id/project", async (req, reply) => {
    strictObject(req.body, ["projectId"], ["remember"]);
    const body = req.body;
    return handle(reply, () => service.setMeetingProject(req.params.id, { projectId: body.projectId, remember: body.remember }));
  });

  app.post("/api/meetings/rules/delete", async (req, reply) => {
    strictObject(req.body, ["id"]);
    const { id } = req.body;
    return handle(reply, () => ({ rules: service.deleteRule(id) }));
  });

  app.post<{ Params: Params }>("/api/meetings/items/:id/edit", async (req, reply) => {
    strictObject(req.body, [], ["text", "dueDate", "projectId"]);
    const body = req.body;
    return handle(reply, () => service.editItem(req.params.id, body));
  });

  app.get<{ Params: Params }>("/api/meetings/items/:id/assignment", async (req, reply) =>
    handle(reply, () => service.assignment(req.params.id)));

  app.post<{ Params: Params }>("/api/meetings/items/:id/link", async (req, reply) => {
    strictObject(req.body, ["runId"]);
    const { runId } = req.body;
    return handle(reply, () => service.linkRun(req.params.id, runId));
  });

  app.post<{ Params: Params }>("/api/meetings/items/:id/status", async (req, reply) => {
    strictObject(req.body, ["action"]);
    const { action } = req.body;
    return handle(reply, () => service.setItemStatus(req.params.id, action));
  });

  /** The owner's call: a promise ("firm") or only an idea ("tentative"). Re-analysis keeps it. */
  app.post<{ Params: Params }>("/api/meetings/items/:id/strength", async (req, reply) => {
    strictObject(req.body, ["strength"]);
    const { strength } = req.body;
    return handle(reply, () => service.setItemStrength(req.params.id, strength));
  });

  app.post<{ Params: Params }>("/api/meetings/recordings/:id/forget", async (req, reply) => {
    strictObject(req.body, []);
    return handle(reply, () => { service.forget(recording(req.params.id)); return { ok: true }; });
  });
}
