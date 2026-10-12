import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { tempDir } from "./helpers.ts";

const apps: FastifyInstance[] = []; const homes: string[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function fixture() {
  const home = tempDir("intel-routes-"); homes.push(home);
  const app = await buildServer(sourcePaths(home, home), { meetings: { keyStore: memoryKeyStore(), fetch: (async () => Response.json({ items: [], next_cursor: null })) as typeof fetch, openAIConnected: () => false, inference: async () => "{}" } });
  apps.push(app);
  const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const send = (method: "POST" | "PUT" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers: { ...headers, "x-dave-csrf": token }, payload });
  return { app, home, headers, get: (url: string) => app.inject({ url, headers }), send };
}
const ID = "0123456789abcdef";

describe("intel routes", () => {
  it("guards origin and CSRF", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/intel/focus" })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/intel/reconcile", headers: f.headers, payload: {} })).statusCode).toBe(403);
  });

  it("serves focus, rejects bad input, 404s unknown things", async () => {
    const f = await fixture();
    expect((await f.get("/api/intel/focus")).json()).toMatchObject({ top: null, queue: [], decisions: [] });
    expect((await f.get("/api/intel/projects/nope")).statusCode).toBe(404);
    expect((await f.send("POST", "/api/intel/reconcile", { projectId: "nope" })).statusCode).toBe(404);
    expect((await f.send("POST", "/api/intel/reconcile", { bogus: 1 })).statusCode).toBe(400);
    expect((await f.send("PATCH", "/api/intel/items/zzz", { locked: true })).statusCode).toBe(400);
    expect((await f.send("PATCH", `/api/intel/items/${ID}`, { locked: true })).statusCode).toBe(404);
    expect((await f.send("POST", `/api/intel/proposals/${ID}/accept`, {})).statusCode).toBe(404);
    expect((await f.get(`/api/intel/objectives/${ID}/brief`)).statusCode).toBe(404);
  });

  it("edits outcome and items, resolves proposals", async () => {
    const f = await fixture();
    const raw = new DatabaseSync(`${f.home}/pcc.db`);
    raw.exec("INSERT INTO projects VALUES('p1','/w/acme','Acme','2026-01-01','2026-01-01')");
    raw.close();
    expect((await f.send("PUT", "/api/intel/projects/p1/outcome", { desiredOutcome: "", acceptanceCriteria: [] })).statusCode).toBe(400);
    expect((await f.send("PUT", "/api/intel/projects/p1/outcome", { desiredOutcome: "x", acceptanceCriteria: [], extra: 1 })).statusCode).toBe(400);
    const put = await f.send("PUT", "/api/intel/projects/p1/outcome", { desiredOutcome: "Acme invoices in portal", acceptanceCriteria: ["Used"], lock: true });
    expect(put.statusCode).toBe(200);
    expect(put.json().outcome).toMatchObject({ basis: "confirmed", locked: true });
    const add = await f.send("POST", "/api/intel/projects/p1/items", { kind: "commitment", title: "Demo to Acme", dueDate: "2026-10-20" });
    expect(add.statusCode).toBe(200);
    expect((await f.send("POST", "/api/intel/projects/p1/items", { kind: "commitment", title: "Demo to Acme" })).statusCode).toBe(409);
    expect((await f.send("POST", "/api/intel/projects/p1/items", { kind: "bad", title: "x" })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/projects/p1/items", { kind: "blocker", title: "x", dueDate: "2026-02-31" })).statusCode).toBe(400);
    const id = add.json().items[0].id as string;
    const lock = await f.send("PATCH", `/api/intel/items/${id}`, { locked: true });
    expect(lock.json().items[0]).toMatchObject({ locked: true, basis: "confirmed" });
    expect(lock.json().history.some((c: { kind: string }) => c.kind === "human_edit")).toBe(true);
    expect((await f.send("PATCH", `/api/intel/items/${id}`, { status: "bogus" })).statusCode).toBe(400);

    // Proposals: seed two through the store, then accept one and reject the other.
    const rec = await f.send("POST", "/api/intel/reconcile", { projectId: "p1" });
    expect(rec.statusCode).toBe(200);
    expect((await f.get("/api/intel/focus")).json().top).toBeTruthy();
  });
});
