// Synthetic-only walkthrough server. Never discovers the operator's real home.
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const root = tempDir("pcc-ui-");
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
const links = [];
const tasks = [];
for (let n = 0; n < 15; n++) {
  const name = n === 0 ? "Synthetic export portal" : `Synthetic project ${n}`;
  const dir = path.join(paths.home, "code", n === 0 ? "synthetic-export-portal-with-a-long-path-for-narrow-screen-evidence" : `project-${n}`);
  writeText(path.join(dir, "README.md"), `# ${name}\n\nSynthetic fixture only. Invoice export tools.`);
  writeJson(path.join(paths.ezcoder.taskProjects, String(n), "meta.json"), { path: dir, name });
  // Legacy attention coverage uses the retained EZBoss adapter, never EZ Coder task lists.
  links.push({ name, cwd: dir });
  tasks.push({ project: name, id: `request-${n}`, title: n === 0 ? "Needs your decision: should the export include archived invoices?" : "Needs your approval to publish the prepared changes", status: "pending", updatedAt: new Date().toISOString() });
}
writeJson(paths.ezboss.links, { projects: links });
writeJson(paths.ezboss.plan, { tasks });
const app = await buildServer(paths, { browserOrigins: ["http://127.0.0.1:4318"] });
const portfolio = (await app.inject('/api/portfolio')).json<Portfolio>();
const seedDb = openDb(paths.appHome);
const seedRepo = makeRepo(seedDb);
for (const [index, p] of portfolio.active.slice(0, 3).entries()) {
  const stored = seedRepo.summary(p.id);
  seedRepo.saveSummary(p.id, stored?.fingerprint ?? '', { ...p.summary, recentFocus: 'Synthetic existing context', suggestedNextAction: index === 0 ? 'Prepare one synthetic acceptance case' : index === 1 ? 'Generated-only synthetic suggestion' : 'Legacy synthetic suggestion', edited: index === 2 });
  await app.inject({ method: 'POST', url: `/api/projects/${p.id}/override`, payload: { pinned: true } });
  if (index === 0) await app.inject({ method: 'POST', url: `/api/projects/${p.id}/summary`, payload: { suggestedNextAction: 'Prepare one synthetic acceptance case' } });
}
seedDb.close();
await app.listen({ host: "127.0.0.1", port: 4318 });
console.log("Synthetic fixture ready at http://127.0.0.1:4318");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
