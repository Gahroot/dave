import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PROMISE = "mi-0123456789abcdef01234567";
const SECOND = "mi-0123456789abcdef01234568";
const USER_SET = "mi-0123456789abcdef01234569";

async function fixture() {
  const root = fs.realpathSync(tempDir("dave-triage-routes-"));
  roots.push(root);
  const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
  const dir = path.join(paths.home, "code", "acme");
  writeText(path.join(dir, "README.md"), "# Acme portal");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeJson(paths.ezcoder.appWorkspace, { windows: [{ cwd: dir }] });
  const app = await buildServer(paths, { meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false } });
  apps.push(app);
  const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { ...headers, "x-dave-csrf": token }, payload });
  const first = (await post("/api/refresh")).json() as Portfolio;
  const projectId = [...first.active, ...first.other][0]?.id ?? "";
  await post(`/api/projects/${projectId}/override`, { pinned: true });

  const seed = new DatabaseSync(path.join(paths.appHome, "pcc.db"));
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  seed.exec("PRAGMA busy_timeout = 5000");
  seed.prepare(`INSERT INTO meetings(recording_id, title, created_at, started_at, status, project_id, project_source, first_seen_at, updated_at)
    VALUES ('100', 'Acme weekly', ?, ?, 'analyzed', ?, 'user', ?, ?)`).run(old, old, projectId, old, old);
  const insert = seed.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, due_date, status, status_source, created_at, updated_at)
    VALUES (?, '100', 'commitment', ?, 'SENTINEL quote', 30, 'Dave', 'me', ?, ?, 'open', ?, ?, ?)`);
  insert.run(PROMISE, "Send the API docs", projectId, old.slice(0, 10), "model", old, old);
  insert.run(SECOND, "Book the training session", projectId, null, "model", old, old);
  insert.run(USER_SET, "Fix the login page", projectId, null, "user", old, old);
  seed.close();
  const status = (id: string) => {
    const read = new DatabaseSync(path.join(paths.appHome, "pcc.db"), { readOnly: true });
    try { return read.prepare("SELECT status, status_source, status_note FROM meeting_items WHERE id = ?").get(id); } finally { read.close(); }
  };
  return { app, headers, post, projectId, status, get: (url: string) => app.inject({ url, headers }) };
}
const promiseRows = (p: Portfolio) => p.inbox.filter((i) => i.kind === "meeting-promise").map((i) => i.title);

describe("triage routes", () => {
  it("requires origin and CSRF", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/triage/batches" })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/triage/preview", headers: f.headers, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/triage/apply", headers: f.headers, payload: { keys: [`m:${PROMISE}`], action: "clear" } })).statusCode).toBe(403);
  });

  it("validates strictly", async () => {
    const f = await fixture();
    const tooMany = Array.from({ length: 1001 }, (_, i) => `m:mi-${i.toString(16).padStart(24, "0")}`);
    for (const [url, body] of [
      ["/api/triage/apply", { keys: ["m:nope"], action: "clear" }],
      ["/api/triage/apply", { keys: [], action: "clear" }],
      ["/api/triage/apply", { keys: tooMany, action: "clear" }],
      ["/api/triage/apply", { keys: [`m:${PROMISE}`], action: "delete" }],
      ["/api/triage/apply", { keys: [`m:${PROMISE}`], action: "clear", source: "voice" }],
      ["/api/triage/preview", { filter: { bogus: 1 } }],
      ["/api/triage/preview", { filter: { buckets: ["nope"] } }],
      ["/api/triage/preview", { extra: true }],
      ["/api/triage/undo", { batchId: "tb-xyz" }],
    ] as const) expect((await f.post(url, body)).statusCode, `${url} ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
    expect((await f.post("/api/triage/undo", { batchId: "tb-000000000000000000000000" })).statusCode).toBe(404);
  });

  it("clears a promise, removes its Inbox row, undoes, and lists batches", async () => {
    const f = await fixture();
    const before = (await f.post("/api/refresh")).json() as Portfolio;
    expect(promiseRows(before).some((t) => t.includes("Send the API docs"))).toBe(true);
    const preview = await f.post("/api/triage/preview", { filter: { buckets: ["overdue_promises"] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().entries.map((e: { key: string }) => e.key)).toEqual([`m:${PROMISE}`]);
    expect(preview.body).not.toContain("SENTINEL");

    const apply = await f.post("/api/triage/apply", { keys: [`m:${PROMISE}`, "m:mi-ffffffffffffffffffffffff"], action: "clear" });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toMatchObject({ changed: 1, skipped: [{ key: "m:mi-ffffffffffffffffffffffff", reason: "gone" }] });
    expect(f.status(PROMISE)).toMatchObject({ status: "dropped", status_source: "user" });
    const after = (await f.get("/api/portfolio")).json() as Portfolio;
    expect(promiseRows(after).some((t) => t.includes("Send the API docs"))).toBe(false);

    const batches = (await f.get("/api/triage/batches")).json().batches;
    expect(batches).toEqual([expect.objectContaining({ id: apply.json().batchId, source: "ui", count: 1, undoneAt: null })]);
    const undo = await f.post("/api/triage/undo", { batchId: apply.json().batchId });
    expect(undo.json()).toMatchObject({ restored: 1, skipped: 0 });
    expect(f.status(PROMISE)).toMatchObject({ status: "open" });
    expect(promiseRows((await f.get("/api/portfolio")).json() as Portfolio).some((t) => t.includes("Send the API docs"))).toBe(true);
  });

  it("rejecting a Confirm commitment decision drops its open promise, but not one you set", async () => {
    const f = await fixture();
    expect((await f.post("/api/intel/reconcile", { projectId: f.projectId })).statusCode).toBe(200);
    const decisions = (await f.get("/api/intel/focus")).json().decisions as { id: string; kind: string; summary: string }[];
    const confirm = (text: string) => decisions.find((d) => d.kind === "new_commitment" && d.summary.includes(text));
    const second = confirm("Book the training session");
    const userSet = confirm("Fix the login page");
    expect(second && userSet).toBeTruthy();
    expect((await f.post(`/api/intel/proposals/${second?.id}/reject`, {})).statusCode).toBe(200);
    expect(f.status(SECOND)).toMatchObject({ status: "dropped", status_source: "user", status_note: "Rejected in Decisions" });
    expect((await f.post(`/api/intel/proposals/${userSet?.id}/reject`, {})).statusCode).toBe(200);
    expect(f.status(USER_SET)).toMatchObject({ status: "open", status_source: "user" });
  });
});
