// Synthetic-only walkthrough server. Never discovers the operator's real home.
import path from "node:path";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const root = tempDir("pcc-ui-");
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
for (let n = 0; n < 15; n++) {
  const name = n === 0 ? "Synthetic export portal" : `Synthetic project ${n}`;
  const dir = path.join(paths.home, "code", n === 0 ? "synthetic-export-portal-with-a-long-path-for-narrow-screen-evidence" : `project-${n}`);
  writeText(path.join(dir, "README.md"), `# ${name}\n\nSynthetic fixture only. Invoice export tools.`);
  writeJson(path.join(paths.ezcoder.taskProjects, String(n), "meta.json"), { path: dir, name });
  writeJson(path.join(paths.ezcoder.taskProjects, String(n), "tasks.json"), [{ id: "request", title: n === 0 ? "Needs your decision: should the export include archived invoices?" : "Needs your approval to publish the prepared changes", status: "pending", updatedAt: new Date().toISOString() }]);
}
const app = await buildServer(paths);
await app.listen({ host: "127.0.0.1", port: 4318 });
console.log("Synthetic fixture ready at http://127.0.0.1:4318");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
