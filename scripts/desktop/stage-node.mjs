#!/usr/bin/env node
// Downloads a pinned official Node 24 build, verifies its sha256 against the
// release SHASUMS256.txt and stages bin/node as the Tauri externalBin sidecar.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "v24.22.0";
const TARGETS = { "aarch64-apple-darwin": "darwin-arm64", "x86_64-apple-darwin": "darwin-x64" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const ti = args.indexOf("--target");
const target = ti >= 0 ? args[ti + 1] : process.arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
const platform = target && TARGETS[target];
if (!platform) {
  console.error(`Unsupported --target ${target}; use one of ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const base = `https://nodejs.org/dist/${NODE_VERSION}`;
const name = `node-${NODE_VERSION}-${platform}`;
const tarball = `${name}.tar.gz`;
const outDir = join(root, "src-tauri", "binaries");
const out = join(outDir, `node-${target}`);
const stamp = `${out}.sha256`;

async function fetchBuf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

if (existsSync(out) && existsSync(stamp) && sha256(readFileSync(out)) === readFileSync(stamp, "utf8").trim()) {
  console.log(`[stage-node] ${out} already staged (${NODE_VERSION}); skipping`);
  process.exit(0);
}

const sums = (await fetchBuf(`${base}/SHASUMS256.txt`)).toString("utf8");
const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, f]) => f === tarball)?.[0];
if (!expected) throw new Error(`No SHASUMS256 entry for ${tarball}`);
console.log(`[stage-node] downloading ${base}/${tarball}`);
const buf = await fetchBuf(`${base}/${tarball}`);
const actual = sha256(buf);
if (actual !== expected) throw new Error(`sha256 mismatch for ${tarball}: ${actual} != ${expected}`);

const tmp = mkdtempSync(join(tmpdir(), "dave-node-"));
try {
  const tgz = join(tmp, tarball);
  writeFileSync(tgz, buf);
  execFileSync("tar", ["-xzf", tgz, "-C", tmp, `${name}/bin/node`], { stdio: "inherit" });
  mkdirSync(outDir, { recursive: true });
  renameSync(join(tmp, name, "bin", "node"), out);
  chmodSync(out, 0o755);
  writeFileSync(stamp, `${sha256(readFileSync(out))}\n`);
  console.log(`[stage-node] staged ${out} (${NODE_VERSION}, tarball sha256 verified)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
