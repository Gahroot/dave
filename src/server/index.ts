import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePaths } from "../shared/paths.ts";
import { openDb } from "../db/index.ts";
import { repo as makeRepo } from "../db/repo.ts";
import { registerRoutes } from "./routes.ts";
import { providerService, type ProviderService } from "../providers/index.ts";
import { registerProviderRoutes } from "./provider-routes.ts";
import { registerDeliveryRoutes } from "./delivery-routes.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import type { AgentOptions } from "../agents/service.ts";
import { createMeetingService, type MeetingServiceOptions } from "../meetings/service.ts";
import { projectCatalog } from "../meetings/extract.ts";
import { applyInboxAction, applyMeetingAttention } from "../meetings/attention.ts";
import { meetingStore } from "../meetings/store.ts";
import { registerMeetingRoutes } from "./meeting-routes.ts";
import { localBrowserOrigins, registerRequestGuard } from "./request-guard.ts";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

export async function buildServer(paths = sourcePaths(), options: { browserOrigins?: string[]; providers?: ProviderService; agentOptions?: AgentOptions; meetings?: MeetingServiceOptions; startMeetingScheduler?: boolean } = {}) {
  const app = Fastify({ logger: false });
  registerRequestGuard(app, options.browserOrigins ?? localBrowserOrigins(Number(process.env.PORT ?? 4317)));
  const db = openDb(paths.appHome);
  const providers = options.providers ?? providerService();
  // Fastify closes hooks in reverse registration order: planner, auth, database.
  app.addHook("onClose", async () => { db.close(); });
  app.addHook("onClose", async () => { providers.close(); });
  registerProviderRoutes(app, providers);
  registerDeliveryRoutes(app, db, providers.inference);
  try { registerAgentRoutes(app, db, paths.appHome, options.agentOptions); }
  catch(e) { await app.close(); throw e; }
  const repo = makeRepo(db);
  // Meeting promises and client ideas join the Inbox inside refresh's own save
  // step, and again whenever meetings change between refreshes.
  const meetingItems = meetingStore(db);
  const reconcile = (candidates: Parameters<typeof repo.reconcileAttention>[0], observed: string[], at: string) =>
    repo.reconcileAttention(candidates, observed, at);
  const rebuildMeetingAttention = (now = new Date()) => {
    const latest = repo.latest();
    if (latest) applyMeetingAttention(meetingItems, reconcile, [...latest.active, ...latest.other], now);
  };
  registerRoutes(app, paths, repo, {
    hooks: { attention: (visible, now) => applyMeetingAttention(meetingItems, reconcile, visible, now) },
    onAttentionAction: (id, action, now) => { if (applyInboxAction(meetingItems, id, action, now)) rebuildMeetingAttention(now); },
  });
  // Registered after the database hook, so it closes first: stops the timer and
  // waits for any sync or analysis to finish writing.
  const meetings = createMeetingService(db, {
    inference: providers.inference,
    // Storage-free: background analysis never touches the Keychain on its own.
    openAIConnected: () => providers.status().openai.state === "connected",
    projects: () => projectCatalog(repo.latest()),
    portfolioProjects: () => { const latest = repo.latest(); return latest ? [...latest.active, ...latest.other] : []; },
    onChanged: () => rebuildMeetingAttention(),
    ...options.meetings,
  });
  app.addHook("onClose", async () => { await meetings.close(); });
  registerMeetingRoutes(app, meetings);
  // Only the real server entry point polls Fathom; tests never start the timer.
  if (options.startMeetingScheduler) meetings.startScheduler();

  if (fs.existsSync(path.join(DIST, "index.html"))) {
    await app.register(fastifyStatic, { root: DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

// Loopback only: this reads private local state and must never be reachable off-box.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4317);
  // Explicit dev proxy origins only; never trust X-Forwarded-* supplied by clients.
  const extraOrigins = process.env.PCC_BROWSER_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  const app = await buildServer(sourcePaths(), { browserOrigins: [...localBrowserOrigins(port), ...extraOrigins], startMeetingScheduler: true });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Portfolio Command Center → http://127.0.0.1:${port}`);
  let stopping = false;
  const shutdown = () => { if (!stopping) { stopping = true; void app.close().catch(() => { process.exitCode = 1; }); } };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
