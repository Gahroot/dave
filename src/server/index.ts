import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePaths } from "../shared/paths.ts";
import { openDb } from "../db/index.ts";
import { repo as makeRepo } from "../db/repo.ts";
import { registerRoutes } from "./routes.ts";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

export async function buildServer(paths = sourcePaths()) {
  const app = Fastify({ logger: false });
  const db = openDb(paths.appHome);
  app.addHook("onClose", async () => { db.close(); });
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
  const app = await buildServer();
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Portfolio Command Center → http://127.0.0.1:${port}`);
}
