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
import { intelService } from "../intel/service.ts";
import { registerIntelRoutes } from "./intel-routes.ts";
import { registerMeetingRoutes } from "./meeting-routes.ts";
import { localBrowserOrigins, registerRequestGuard } from "./request-guard.ts";
import { createDocumentService } from "../documents/service.ts";
import type { TextExtractor } from "../documents/types.ts";
import { registerDocumentRoutes } from "./document-routes.ts";
import { createVoiceService } from "../voice/service.ts";
import { registerVoiceRoutes } from "./voice-routes.ts";
import { createTriageService } from "../triage/service.ts";
import { registerTriageRoutes } from "./triage-routes.ts";
import { createMobileService, type MobileServiceOptions } from "../mobile/service.ts";
import { mobileSettings } from "../mobile/settings.ts";
import { registerMobileRoutes } from "./mobile-routes.ts";
import { createWorkService } from "../work/service.ts";
import { readWorkEvidence } from "../work/store.ts";
import { registerWorkRoutes } from "./work-routes.ts";
import { ledgerService } from "../intel/ledger.ts";
import { registerReviewRoutes } from "./review-routes.ts";
import { createNextService } from "../intel/next.ts";
import { registerNextRoutes } from "./next-routes.ts";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

export async function buildServer(paths = sourcePaths(), options: { browserOrigins?: string[]; providers?: ProviderService; agentOptions?: AgentOptions; meetings?: MeetingServiceOptions; startMeetingScheduler?: boolean; startIntelScheduler?: boolean;
  /** Real server entry only: poll EZ Coder runs, local git and (opt-in) GitHub every minute. Tests never start it. */
  startWorkWatcher?: boolean;
  voice?: { fetch?: typeof fetch; now?: () => Date }; documents?: { extractor?: TextExtractor }; mobile?: MobileServiceOptions; startMobileGateway?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const origins = options.browserOrigins ?? localBrowserOrigins(Number(process.env.PORT ?? 4317));
  registerRequestGuard(app, origins);
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
  // Recommendation ledger: logs every pick DAVE makes and how it was resolved. Writes only its own tables.
  // Names resolve lazily (projectNameOf is declared below and only called at runtime).
  const ledger = ledgerService(db, { now: () => new Date(), projectName: (id) => projectNameOf(id) });
  // Delivery Intelligence: deterministic reconcile + prioritiser. Reads only; never launches agents.
  // Rejecting a "Confirm commitment" decision also drops its still-open meeting promise (called at runtime only).
  // Linked work events (EZ Coder runs, commits, merged PRs) feed code evidence; every re-rank is logged in the ledger.
  const intel = intelService(db, {
    latest: () => repo.latest(), onCommitmentRejected: (ids) => dropRejectedPromises(ids),
    workEvidence: (projectId) => readWorkEvidence(db, projectId, new Date()),
    onRecommendations: (snapshot) => ledger.observe(snapshot),
  });
  app.addHook("onClose", async () => { intel.close(); });
  // Meeting promises and client ideas join the Inbox inside refresh's own save
  // step, and again whenever meetings change between refreshes.
  const meetingItems = meetingStore(db);
  const reconcile = (candidates: Parameters<typeof repo.reconcileAttention>[0], observed: string[], at: string) =>
    repo.reconcileAttention(candidates, observed, at);
  const rebuildMeetingAttention = (now = new Date()) => {
    const latest = repo.latest();
    if (latest) applyMeetingAttention(meetingItems, reconcile, [...latest.active, ...latest.other], now);
  };
  function dropRejectedPromises(ids: string[]): void {
    const at = new Date();
    let changed = false;
    for (const id of [...ids].sort()) {
      const item = meetingItems.item(id);
      if (!item || (item.status !== "open" && item.status !== "looks_done") || item.statusSource === "user") continue;
      changed = meetingItems.setItemStatus(id, { status: "dropped", source: "user", note: "Rejected in Decisions" }, at.toISOString()) || changed;
    }
    if (changed) rebuildMeetingAttention(at);
  }
  const portfolio = registerRoutes(app, paths, repo, {
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
    onChanged: () => {
      rebuildMeetingAttention();
      try { intel.reconcileSync(); } catch { /* intelligence must never break meeting sync */ }
    },
    ...options.meetings,
  });
  app.addHook("onClose", async () => { await meetings.close(); });
  registerMeetingRoutes(app, meetings);
  registerIntelRoutes(app, intel);
  // Completion loop: notices finished work, reconciles that project and reports what moved. Read-only on sources.
  const work = createWorkService({
    db, paths, intel,
    projects: () => {
      const latest = repo.latest();
      return latest ? latest.active.filter((p) => p.exists && !p.override.hidden)
        .map((p) => ({ id: p.id, name: p.name, path: p.canonicalPath })).sort((a, b) => a.id.localeCompare(b.id)) : [];
    },
  });
  app.addHook("onClose", async () => { work.close(); });
  work.onProgress((report) => ledger.onProgress(report));
  registerWorkRoutes(app, work);
  // Prepared next actions and the briefing. Record ops only: DAVE never starts work (hand_to_ezcoder is refused).
  const next = createNextService({ db, intel, meetings, work, ledger, now: () => new Date() });
  registerNextRoutes(app, next);
  registerReviewRoutes(app, ledger, intel);
  // Talk to DAVE. Registered last so it closes first (voice, then documents, then the hooks above).
  // Nothing here touches the network or the Keychain until the user starts a voice session.
  const visibleProjects = () => {
    const latest = repo.latest();
    const seen = new Map<string, string>();
    const hidden = new Set(latest ? latest.hidden.map((p) => p.id) : []);
    if (latest) for (const p of [...latest.active, ...latest.other]) if (!p.override.hidden) seen.set(p.id, p.name);
    for (const p of repo.projects()) if (!hidden.has(p.id) && !seen.has(p.id)) seen.set(p.id, p.name);
    try { for (const r of intel.focus().projects) if (!seen.has(r.projectId)) seen.set(r.projectId, r.projectName); } catch { /* intel unavailable */ }
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  const projectNameOf = (id: string): string | null => {
    const latest = repo.latest();
    const hit = latest ? [...latest.active, ...latest.other, ...latest.hidden].find((p) => p.id === id) : undefined;
    return hit?.name ?? (intel.knownProject(id) ? (repo.projects().find((p) => p.id === id)?.name ?? null) : null);
  };
  // Clean up: bulk clear / mark done with undo. `triage` is the service a voice worker can hand to createVoiceService.
  const triage = createTriageService({
    db, now: () => new Date(), projectName: projectNameOf,
    onChanged: () => {
      rebuildMeetingAttention();
      try { intel.reconcileSync(); } catch { /* intelligence must never break clean-up */ }
    },
  });
  registerTriageRoutes(app, triage);
  const documents = createDocumentService(db, paths.appHome, {
    ...(options.documents?.extractor ? { extractor: options.documents.extractor } : {}),
    projectName: projectNameOf,
    knownProject: (id) => intel.knownProject(id),
  });
  app.addHook("onClose", async () => { await documents.close(); });
  registerDocumentRoutes(app, documents);
  const voice = createVoiceService({
    db, providers, intel, documents, portfolio,
    meetings: {
      items: (filter) => meetings.items(filter),
      setItemStatus: (id, action) => meetings.setItemStatus(id, action),
      setItemStrength: (id, strength) => meetings.setItemStrength(id, strength),
      recentMeetings: (limit) => meetings.list().filter((m) => m.status === "analyzed").slice(0, Math.max(0, limit))
        .map((m) => ({ recordingId: m.recordingId, title: m.title, at: m.startedAt ?? m.createdAt })),
      syncNow: () => meetings.syncNow(),
      fathomConnected: () => !!meetingItems.settings().connectedAt,
    },
    projects: visibleProjects,
    triage,
    ...(options.voice?.fetch ? { fetch: options.voice.fetch } : {}),
    ...(options.voice?.now ? { now: options.voice.now } : {}),
  });
  app.addHook("onClose", async () => { voice.close(); });
  registerVoiceRoutes(app, voice);
  // Only the real server entry point polls Fathom; tests never start the timer.
  if (options.startMeetingScheduler) meetings.startScheduler();
  if (options.startIntelScheduler) intel.startScheduler();
  if (options.startWorkWatcher) work.start();
  // Phone access: registered after the database hook so the LAN listener closes
  // first. It binds only when the entry point (or an explicit test) asks.
  const [firstOrigin = ""] = origins;
  const mobile = createMobileService(app, firstOrigin, mobileSettings(db), { ...options.mobile, allowListen: options.startMobileGateway === true });
  app.addHook("onClose", async () => { await mobile.close(); });
  registerMobileRoutes(app, mobile);
  if (options.startMobileGateway) app.addHook("onReady", async () => { await mobile.start(); });

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
  const app = await buildServer(sourcePaths(), { browserOrigins: [...localBrowserOrigins(port), ...extraOrigins], startMeetingScheduler: true, startIntelScheduler: true, startWorkWatcher: true, startMobileGateway: true });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Portfolio Command Center → http://127.0.0.1:${port}`);
  let stopping = false;
  const shutdown = () => { if (!stopping) { stopping = true; void app.close().catch(() => { process.exitCode = 1; }); } };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
