// Temporary project, temporary app data and fixture agent only. No live account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { openDb } from "../src/db/index.ts";
import { repo } from "../src/db/repo.ts";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dave-agent-ui-")));
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
const project = path.join(root, "synthetic-project"); fs.mkdirSync(project);
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", project, ...args], { stdio: "pipe" });
git("init", "-q"); fs.writeFileSync(path.join(project, "README.md"), "# Synthetic agent fixture\n"); git("add", "README.md");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Fixture");
const db = openDb(paths.appHome); repo(db).ensureProject(project, "Synthetic agent project", new Date().toISOString()); db.close();
const start = async () => {
  const server = await buildServer(paths, { browserOrigins: ["http://127.0.0.1:4323"], agentOptions: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/agent-acp.mjs", import.meta.url))] } });
  await server.listen({ host: "127.0.0.1", port: 4323 });
  return server;
};
let app = await start();
console.log("Agent fixture ready http://127.0.0.1:4323");
// Harness-owned signal, not an HTTP test backdoor. Exercise real runtime shutdown,
// retained storage and startup recovery rather than patching a run's status in the DB.
let restart: Promise<void> | null = null;
process.on("SIGUSR2", () => {
  if (restart) return;
  restart = (async () => {
    await app.close(); app = await start();
    console.log("Agent fixture restarted");
    process.send?.("agent-fixture-restarted");
  })();
  void restart.then(() => { restart = null; }, error => { console.error(error); process.exitCode = 1; });
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  void (async () => { await restart; await app.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); })();
});
