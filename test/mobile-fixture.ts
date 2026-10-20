// Synthetic-only phone verification server. Never discovers the operator's real home, never
// touches the Keychain (memory stores) and binds loopback only, so an iOS Simulator on this Mac
// can pair with it. Prints a disposable pairing link for this run.
//   node --experimental-strip-types test/mobile-fixture.ts
import path from "node:path";
import type { Portfolio } from "../src/shared/types.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { memoryPairingStore } from "../src/mobile/pairing-store.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const PORT = Number(process.env.FIXTURE_PORT ?? 4330);
const MOBILE_PORT = Number(process.env.FIXTURE_MOBILE_PORT ?? 4331);
const origin = `http://127.0.0.1:${PORT}`;
const root = tempDir("pcc-mobile-");
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
const links = [];
const tasks = [];
for (let n = 0; n < 6; n++) {
  const name = n === 0 ? "Synthetic export portal" : `Synthetic project ${n}`;
  const dir = path.join(paths.home, "code", `project-${n}`);
  writeText(path.join(dir, "README.md"), `# ${name}\n\nSynthetic fixture only. Invoice export tools.`);
  writeJson(path.join(paths.ezcoder.taskProjects, String(n), "meta.json"), { path: dir, name });
  links.push({ name, cwd: dir });
  tasks.push({ project: name, id: `request-${n}`, title: n === 0 ? "Needs your decision: should the export include archived invoices?" : "Needs your approval to publish the prepared changes", status: "pending", updatedAt: new Date().toISOString() });
}
writeJson(paths.ezboss.links, { projects: links });
writeJson(paths.ezboss.plan, { tasks });

const app = await buildServer(paths, {
  browserOrigins: [origin],
  meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false, inference: async () => "{}" },
  mobile: { store: memoryPairingStore(), port: MOBILE_PORT, listenHost: "127.0.0.1", hosts: () => ["127.0.0.1"], hostname: () => "Fixture Mac" },
  startMobileGateway: true,
});
await app.listen({ host: "127.0.0.1", port: PORT });
const headers = { host: `127.0.0.1:${PORT}`, origin, "sec-fetch-site": "same-origin" };
await app.inject({ url: "/api/portfolio", headers }).then((r) => r.json<Portfolio>());
const token = (await app.inject({ url: "/api/security/csrf", headers })).json<{ token: string }>().token;
const enabled = await app.inject({ method: "POST", url: "/api/mobile/pairing/enable", headers: { ...headers, "x-dave-csrf": token, "content-type": "application/json" }, payload: {} });
const status = enabled.json<{ link: string | null; error: string | null }>();
if (!status.link) throw new Error(`Phone access did not start: ${status.error ?? enabled.statusCode}`);
console.log(`Mobile fixture ready at ${origin} (gateway 127.0.0.1:${MOBILE_PORT})`);
console.log(`PAIRING_LINK ${status.link}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
