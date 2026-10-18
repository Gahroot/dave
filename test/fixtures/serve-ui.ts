/**
 * Dev-only server for UI screenshots against a folder made by seed-ui.ts. Never imported by src/.
 *
 * `npm run server` always starts the Fathom, intel and work schedulers, and its credentials live in the macOS
 * Keychain (outside HOME), so pointing it at a fixture HOME could still sync or analyze with the owner's real
 * accounts. This launcher starts no scheduler, keeps the Fathom key and OpenAI sign-in in memory only (both
 * empty), and refuses every outbound request.
 *
 *   node --experimental-strip-types test/fixtures/serve-ui.ts /tmp/dave-ui-fixture
 */
import fs from "node:fs";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import { sourcePaths } from "../../src/shared/paths.ts";
import { localBrowserOrigins } from "../../src/server/request-guard.ts";
import { createProviderService } from "../../src/providers/index.ts";
import { OpenAIAuth } from "../../src/providers/openai-auth.ts";
import { PlanningFailure } from "../../src/providers/openai.ts";
import { credentialStore } from "../../src/providers/openai-storage.ts";
import { memoryKeyStore } from "../../src/meetings/credentials.ts";

const MARKER = ".dave-ui-fixture";
const PORT = 4317;

function fail(message: string): never {
  console.error(`serve-ui: ${message}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail("usage: node --experimental-strip-types test/fixtures/serve-ui.ts <root made by seed-ui.ts>");
const root = fs.realpathSync(path.resolve(arg));
if (!fs.existsSync(path.join(root, MARKER))) fail(`refusing ${root}: it was not made by seed-ui.ts`);
const home = path.join(root, "home"), appHome = path.join(root, "app");
if (process.env.HOME !== home || process.env.PCC_HOME !== appHome) fail(`run with HOME=${home} PCC_HOME=${appHome}`);

const offline = (async () => { throw new Error("serve-ui: network is off for the UI fixture"); }) as typeof fetch;
const noModel = async (): Promise<string> => { throw new PlanningFailure("connection_required"); };

const app = await buildServer(sourcePaths(home, appHome), {
  browserOrigins: localBrowserOrigins(PORT),
  providers: createProviderService({ authFactory: () => new OpenAIAuth("session", { store: credentialStore("session"), fetch: offline }), inference: noModel }),
  meetings: { keyStore: memoryKeyStore(), fetch: offline, inference: noModel, openAIConnected: () => false },
  voice: { fetch: offline },
});
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`DAVE UI fixture → http://127.0.0.1:${PORT}`);
let stopping = false;
const shutdown = () => { if (!stopping) { stopping = true; void app.close().catch((e: unknown) => { console.error("serve-ui: close failed", e); process.exitCode = 1; }); } };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
