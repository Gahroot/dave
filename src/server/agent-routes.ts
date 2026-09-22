import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { agentStore } from "../agents/store.ts";
import { agentService, type AgentOptions } from "../agents/service.ts";
import { AgentError, object, text } from "../agents/types.ts";
import { deliveryCoordinationRepo } from "../db/delivery-coordination-repo.ts";
import { deriveDeliveryProgress } from "../model/delivery-progress.ts";
import { coordinationAssignment, resultTemplate } from "../ui/coordination-handoff.ts";

export function registerAgentRoutes(app: FastifyInstance, db: Db, appHome: string, options: AgentOptions = {}) {
  const store = agentStore(db), delivery = deliveryCoordinationRepo(db);
  function handoff(projectId: string, handoffId: string) {
    const data = delivery.read(projectId), progress = deriveDeliveryProgress(data.state, data.coordination);
    const item = progress.milestones.find(m => m.handoff?.id === handoffId);
    if (progress.stale || !item?.handoff || item.status !== "handed-off") throw new AgentError(409, "Delivery assignment is stale or no longer ready");
    const project = store.projects().find(p => p.id === projectId);
    if (!project) throw new AgentError(404, "Project unavailable");
    const template = resultTemplate(projectId, item.handoff);
    const prompt = coordinationAssignment({ projectName: project.name, projectPath: "the DAVE-assigned workspace (not the original checkout)", ...data, handoff: item.handoff }) + `\n\nAt the end of your turn, include a complete evidence report between DAVE_REPORT_BEGIN and DAVE_REPORT_END, using this JSON shape. Set criterion statuses honestly; unknown is allowed. Do not fabricate command results.\n${JSON.stringify(template)}`;
    return { projectId, handoffId, title: item.milestone.title, prompt, criteria: item.handoff.criteria.map(c => c.text) };
  }
  const service = agentService(store, appHome, { ...options, beforeDispatch(run) {
    options.beforeDispatch?.(run);
    if (!run.handoffId) return;
    const data = delivery.read(run.projectId), progress = deriveDeliveryProgress(data.state, data.coordination);
    const item = progress.milestones.find(m => m.handoff?.id === run.handoffId);
    if (progress.stale || !item || !["handed-off", "needs-review"].includes(item.status)) throw new AgentError(409, "Delivery assignment changed; prepare a current assignment before running");
  }, onResult(run, output) {
    options.onResult?.(run, output);
    if (!run.handoffId) return;
    const match = /DAVE_REPORT_BEGIN\s*([\s\S]*?)\s*DAVE_REPORT_END/.exec(output);
    if (!match) { store.event(run.id, "delivery", "No structured delivery report received. Reply asking the agent for the assigned evidence report."); return; }
    try {
      const report = object(JSON.parse(match[1]!));
      if (report.handoffId !== run.handoffId) throw new Error("Assignment mismatch");
      const { state } = delivery.read(run.projectId);
      delivery.submit(run.projectId, state.revision, `${run.id}:${run.turn}`, report);
      store.event(run.id, "delivery", "Evidence report imported into Delivery. Milestone acceptance remains an explicit human decision.");
    } catch { store.event(run.id, "delivery", "Delivery report could not be imported: invalid or stale evidence. Review Delivery and request a corrected report."); }
  } });
  app.addHook("onClose", async () => service.close());
  const handle = async <T>(fn: () => T | Promise<T>, reply: { code: (code: number) => { send: (body: unknown) => unknown } }) => {
    try { return await fn(); } catch(e) { if (e instanceof AgentError) return reply.code(e.statusCode).send({ error: e.message }); throw e; }
  };
  app.get("/api/agents", async () => ({ settings: store.settings(), runs: store.list().map(r => ({ ...r, packet: null, prompt: "", nextPrompt: "" })), projects: store.projects(), runner: service.runner }));
  app.post("/api/agents/settings", async (req, reply) => handle(() => { const result = store.configure(object(req.body)); service.tick(); return result; }, reply));
  app.get<{ Params: { projectId: string; handoffId: string } }>("/api/agents/delivery/:projectId/:handoffId", async (req, reply) => handle(() => handoff(req.params.projectId, req.params.handoffId), reply));
  app.post("/api/agents/runs", async (req, reply) => handle(() => {
    let body = object(req.body);
    if (body.handoffId) {
      const prior = store.previous(text(body.requestKey, 128));
      if (prior && (prior.projectId !== body.projectId || prior.handoffId !== body.handoffId)) throw new AgentError(409, "Request key already used");
      body = { ...body, ...(prior ? { title: prior.title, prompt: prior.prompt, criteria: prior.criteria } : handoff(text(body.projectId, 200), text(body.handoffId, 200))) };
    }
    const run = store.enqueue(body); service.tick(); return run;
  }, reply));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/agents/runs/:id", async (req, reply) => handle(() => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentError(400, "Invalid event cursor");
    return { run: store.read(req.params.id), events: store.events(req.params.id, after), history: store.history(req.params.id) };
  }, reply));
  app.get<{ Params: { id: string; packetId: string } }>("/api/agents/runs/:id/evidence/:packetId", async (req, reply) => handle(() => {
    const packetId = Number(req.params.packetId);
    if (!Number.isSafeInteger(packetId) || packetId < 1) throw new AgentError(400, "Invalid evidence identity");
    return store.evidence(req.params.id, packetId);
  }, reply));
  app.post<{ Params: { id: string } }>("/api/agents/runs/:id/actions", async (req, reply) => handle(() => service.action(req.params.id, object(req.body)), reply));
  return { store, service };
}
