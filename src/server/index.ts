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
import { localBrowserOrigins, registerRequestGuard } from "./request-guard.ts";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

export async function buildServer(paths = sourcePaths(), options: { browserOrigins?: string[]; providers?: ProviderService } = {}) {
  const app = Fastify({ logger: false });
  registerRequestGuard(app, options.browserOrigins ?? localBrowserOrigins(Number(process.env.PORT ?? 4317)));
  const db = openDb(paths.appHome);
  const providers = options.providers ?? providerService();
  // Fastify closes hooks in reverse registration order: planner, auth, database.
  app.addHook("onClose", async () => { db.close(); });
  app.addHook("onClose", async () => { providers.close(); });
  registerProviderRoutes(app, providers);
  registerDeliveryRoutes(app, db, providers.inference);
  const repo = makeRepo(db);
  registerRoutes(app, paths, repo);

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
  const app = await buildServer(sourcePaths(), { browserOrigins: [...localBrowserOrigins(port), ...extraOrigins] });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Portfolio Command Center → http://127.0.0.1:${port}`);
}
