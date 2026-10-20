import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { REFUSE_EXECUTION } from "../src/intel/next.ts";
import { tempDir } from "./helpers.ts";

/**
 * DAVE never starts work. Pew starts EZ Coder itself after a spoken yes; DAVE only prepares the brief and records
 * decisions. These checks pin that boundary: no route to Pew2's daemon, no Pew2 process, no agent import in the
 * prepared-action path, and the act route refuses the hand-off op.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  }).sort();
}
const rel = (p: string) => path.relative(SRC, p);

// Pew2's daemon port, its env vars, a URL to it, or a spawned/fetched pew2. Read-only discovery of
// ~/.pew2/known-projects.json (a path, not a process or URL) is allowed and does not match these.
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "Pew2 daemon port 8787", re: /\b8787\b/ },
  { name: "PEW2_ environment variable", re: /\bPEW2_/ },
  { name: "URL to Pew", re: /(?:https?|wss?):\/\/[^\s"'`]*pew/i },
  { name: "spawning a pew process", re: /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(\s*["'`][^"'`]*pew/i },
  { name: "fetching Pew", re: /\bfetch\s*\(\s*["'`][^"'`]*pew/i },
];

// The prepared-action, briefing, ledger and review path: record ops only, so nothing here may reach agents or processes.
const RECORD_ONLY = ["intel/next.ts", "intel/prepare.ts", "intel/briefing.ts", "intel/ledger.ts", "intel/review.ts", "server/next-routes.ts", "server/review-routes.ts"];

const apps: FastifyInstance[] = []; const homes: string[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("DAVE never executes work through Pew", () => {
  it("no src file talks to Pew2's daemon or starts a Pew2 process", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const f of FORBIDDEN) if (f.re.test(text)) hits.push(`${rel(file)}: ${f.name}`);
    }
    expect(hits).toEqual([]);
  });

  it("the prepared-action path imports nothing from agents and spawns nothing", () => {
    const hits: string[] = [];
    for (const r of RECORD_ONLY) {
      const text = fs.readFileSync(path.join(SRC, r), "utf8");
      const imports = [...text.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
      for (const spec of imports) {
        if (/(^|\/)agents\//.test(spec)) hits.push(`${r} imports ${spec}`);
        if (/^(node:)?child_process$/.test(spec)) hits.push(`${r} imports ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("POST /api/intel/next/:id/act refuses hand_to_ezcoder with 409", async () => {
    const home = tempDir("dave-no-exec-"); homes.push(home);
    const app = await buildServer(sourcePaths(home, home), { meetings: { keyStore: memoryKeyStore(), fetch: (async () => Response.json({ items: [], next_cursor: null })) as typeof fetch, openAIConnected: () => false, inference: async () => "{}" } });
    apps.push(app);
    const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
    const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
    const res = await app.inject({ method: "POST", url: "/api/intel/next/0123456789abcdef/act", headers: { ...headers, "x-dave-csrf": token }, payload: { op: "hand_to_ezcoder" } });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain(REFUSE_EXECUTION);
  });
});
