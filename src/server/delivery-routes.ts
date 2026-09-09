import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/index.ts";
import { deliveryRepo, DeliveryError } from "../db/delivery-repo.ts";
import { collectDeliveryContext, CONTEXT_CATEGORIES, type ContextPermissions } from "../model/delivery-context.ts";
import { deliveryPlanner, type GenerationPurpose } from "../model/delivery-planner.ts";
import type { DeliveryGoal } from "../model/delivery-schema.ts";
import { PlanningFailure, type PlanningInference } from "../providers/openai.ts";
import { strictObject } from "./provider-routes.ts";

export function registerDeliveryRoutes(app: FastifyInstance, db: Db, inference: PlanningInference) {
  const repo = deliveryRepo(db), planner = deliveryPlanner(db, inference);
  app.addHook("onClose", async () => { planner.close(); });
  const base = "/api/projects/:id/delivery";
  const settings = db.prepare("SELECT revision,permissions_json,fingerprint FROM delivery_context_settings WHERE project_id=?");
  const saveSettings = db.prepare("INSERT INTO delivery_context_settings(project_id,revision,permissions_json,fingerprint) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,permissions_json=excluded.permissions_json,fingerprint=excluded.fingerprint");
  function expected(id: string, revision: unknown) {
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new DeliveryError("invalid", "Invalid revision");
    const state = repo.read(id);
    if (state.revision !== revision) throw new DeliveryError("conflict", "Delivery state changed", state);
    return state;
  }
  function permissions(value: unknown): ContextPermissions {
    strictObject(value, ["collect", "categories", "documents"], ["additionalFiles"]);
    if (value.collect !== true || !Array.isArray(value.categories) || value.categories.length > 6 || !value.categories.includes("goal") || new Set(value.categories).size !== value.categories.length || value.categories.some(c => !CONTEXT_CATEGORIES.includes(c)) || !Array.isArray(value.documents) || value.documents.length > 8 || value.documents.some(d => typeof d !== "string" || !/^(?:(?:docs|doc)\/)?(?:README|PRODUCT|SCOPE|BRIEF|SPEC|ARCHITECTURE)\.md$/i.test(d))) throw new DeliveryError("invalid", "Invalid context selection");
    if (value.additionalFiles !== undefined) {
      if (!Array.isArray(value.additionalFiles) || value.additionalFiles.length > 4) throw new DeliveryError("invalid", "Invalid file selection");
      for (const file of value.additionalFiles) {
        strictObject(file, ["path", "reviewedSha256"]);
        if (typeof file.path !== "string" || !/^(?:docs|doc)\/[a-z0-9-]{1,64}\.md$/i.test(file.path) || /task|agent|session|transcript|client|customer|upload|credential|secret|token|summary|notes|env/i.test(file.path) || typeof file.reviewedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.reviewedSha256)) throw new DeliveryError("invalid", "Invalid file review");
      }
    }
    return value as ContextPermissions;
  }
  async function collect(id: string, revision: number, selection: ContextPermissions) {
    const state = expected(id, revision);
    const project = db.prepare("SELECT p.id,p.canonical_path AS canonicalPath,COALESCE(o.hidden,0) AS hidden FROM projects p LEFT JOIN project_overrides o ON o.project_id=p.id WHERE p.id=?").get(id) as { id: string; canonicalPath: string; hidden: number };
    if (project.hidden || !state.goal?.provider || !state.goal.model) throw new DeliveryError("invalid", "Select an available project and planning model first");
    try {
      const packet = await collectDeliveryContext({ project, goal: state.goal, provider: state.goal.provider, model: state.goal.model, permissions: selection, history: state.history, plans: state.plans });
      expected(id, revision);
      return packet;
    } catch (error) { if (error instanceof DeliveryError) throw error; throw new DeliveryError("invalid", "Context unavailable or changed; review a fresh preview"); }
  }
  async function start(id: string, revision: number, purpose: GenerationPurpose) {
    const state = expected(id, revision);
    const saved = settings.get(id) as { permissions_json: string; fingerprint: string } | undefined;
    if (!saved || !state.goal?.consent) throw new DeliveryError("conflict", "context-changed: preview and approve context", state);
    const packet = await collect(id, revision, permissions(JSON.parse(saved.permissions_json)));
    if (packet.fingerprint !== saved.fingerprint || packet.fingerprint !== state.goal.consent.fingerprint) throw new DeliveryError("conflict", "context-changed: preview and approve context", state);
    try { return planner.start({ projectId: id, expectedRevision: revision, packet, purpose }); }
    catch (error) { if (error instanceof PlanningFailure && error.code === "stale") throw new DeliveryError("conflict", "Delivery state changed", repo.read(id)); throw error; }
  }
  function failure(error: unknown, reply: FastifyReply) {
    if (error instanceof DeliveryError) return reply.code(error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400).send({ error: error.message, ...(error.state ? { state: error.state } : {}) });
    if (error instanceof PlanningFailure) return reply.code(error.code === "stale" ? 409 : 503).send({ error: error.code });
    throw error;
  }
  app.get<{ Params: { id: string } }>(base, async (req, reply) => {
    try { return { state: repo.read(req.params.id), operation: planner.latest(req.params.id) }; } catch (error) { return failure(error, reply); }
  });
  app.get<{ Params: { id: string; operationId: string } }>(`${base}/operations/:operationId`, async (req, reply) => {
    try { repo.read(req.params.id); return planner.status(req.params.id, req.params.operationId) ?? reply.code(404).send({ error: "Unknown operation" }); } catch (error) { return failure(error, reply); }
  });
  for (const action of ["goal", "context/preview", "context/approve", "generate", "replan", "cancel", ":milestoneId/complete", ":milestoneId/block", ":milestoneId/reopen"] as const) {
    app.post<{ Params: { id: string; milestoneId?: string } }>(`${base}/${action}`, async (req, reply) => {
      const id = req.params.id;
      try {
        repo.read(id);
        const required = action === "goal" ? ["goal"] : action === "context/preview" ? ["permissions"] : action === "context/approve" ? ["fingerprint"] : action === "cancel" ? ["operationId"] : action.endsWith("complete") ? ["idempotencyKey", "report"] : action.includes(":milestoneId") ? ["reason"] : [];
        strictObject(req.body, ["expectedRevision", ...required]);
        const body = req.body, revision = body.expectedRevision;
        // Completion checks deduplication before revision comparison in BEGIN IMMEDIATE.
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new DeliveryError("invalid", "Invalid revision");
        if (action.endsWith("complete")) {
          strictObject(body.report, ["outcome", "evidence"]);
          const result = repo.complete(id, revision as number, req.params.milestoneId!, body.idempotencyKey as string, body.report as { outcome: string; evidence: string });
          let operation = planner.latest(id), recovery: string | null = null;
          if (!result.duplicate && result.state.nextPlans.some(n => n.revision === result.state.revision && n.status === "pending")) {
            try { operation = await start(id, result.state.revision, "continue"); }
            catch (error) {
              const code = error instanceof PlanningFailure ? error.code : "context-changed";
              recovery = `${code}: preview and approve context, then Generate to retry; completion remains saved`;
              // Another guarded command may have advanced the revision during collection.
              // Never turn an already-saved completion into a failed response.
              try { repo.nextPlanFailure(id, result.state.revision, code); } catch { /* superseded continuation */ }
            }
          }
          return { ...result, state: repo.read(id), source: "user-reported", operation, recovery };
        }
        const state = expected(id, revision);
        if (action === "goal") {
          strictObject(body.goal, ["goal", "intendedUser", "workflow", "stage", "provider", "model", "consent"]);
          if (body.goal.consent !== null) throw new DeliveryError("invalid", "Approve server-collected context separately");
          return { state: repo.saveGoal(id, state.revision, body.goal as DeliveryGoal) };
        }
        if (action === "context/preview") {
          const selection = permissions(body.permissions), packet = await collect(id, state.revision, selection);
          saveSettings.run(id, state.revision, JSON.stringify(selection), packet.fingerprint);
          return { packet, expectedRevision: state.revision };
        }
        if (action === "context/approve") {
          const saved = settings.get(id) as { revision: number; permissions_json: string; fingerprint: string } | undefined;
          if (!saved || saved.revision !== state.revision || saved.fingerprint !== body.fingerprint) throw new DeliveryError("conflict", "Preview changed; collect a fresh preview", state);
          const packet = await collect(id, state.revision, permissions(JSON.parse(saved.permissions_json)));
          if (packet.fingerprint !== body.fingerprint) throw new DeliveryError("conflict", "context-changed: collect a fresh preview", state);
          return { state: repo.saveGoal(id, state.revision, { ...state.goal!, consent: { fingerprint: packet.fingerprint, categories: packet.categories } }) };
        }
        if (action === "generate" || action === "replan") {
          const continuation = state.nextPlans.find(n => n.revision === state.revision);
          const purpose = continuation?.status === "error" ? "retry" : continuation?.status === "pending" ? "continue" : action;
          const operation = await start(id, state.revision, purpose);
          return reply.code(202).send({ operationId: operation.id, operation });
        }
        if (action === "cancel") {
          if (typeof body.operationId !== "string" || !planner.status(id, body.operationId)) return reply.code(404).send({ error: "Unknown operation" });
          planner.cancel(id, body.operationId); return { operation: planner.status(id, body.operationId) };
        }
        return { state: action.endsWith("block") ? repo.block(id, state.revision, req.params.milestoneId!, body.reason as string) : repo.reopen(id, state.revision, req.params.milestoneId!, body.reason as string) };
      } catch (error) { return failure(error, reply); }
    });
  }
  return planner;
}
