/**
 * Metro for an app that shares pure TypeScript with the DAVE server.
 *
 * The phone imports the wire protocol (`../src/mobile/protocol.ts`), the shared
 * domain types and the web UI's pure models (`../src/ui/*-model.ts`,
 * `../src/ui/status.ts`) directly, so both apps derive labels, grouping and
 * status language from one source. Only that folder is watched — never the repo
 * root, which holds Rust build output and the server's node_modules.
 *
 * Bare package imports made by shared files resolve as if made from this app,
 * so React, React Native and @noble come from this app's node_modules once,
 * never from the server's node_modules beside ../src.
 * `lucide-react` (used by the shared status map) is redirected to
 * `lucide-react-native`, which exports the same icon names.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "../src");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];
const appOrigin = path.join(projectRoot, "index.ts");
const isBare = (name) => !name.startsWith(".") && !path.isAbsolute(name);

const ALIASES = { "lucide-react": "lucide-react-native" };
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  const target = ALIASES[moduleName] ?? moduleName;
  // Server-only modules must never reach the phone bundle.
  if (target.startsWith("node:")) throw new Error(`"${target}" is server-only and cannot be bundled into the phone app (imported from ${context.originModulePath})`);
  const fromShared = context.originModulePath.startsWith(sharedRoot + path.sep);
  return resolve(fromShared && isBare(target) ? { ...context, originModulePath: appOrigin } : context, target, platform);
};

module.exports = config;
