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

  it("delivery routes: schedule, steps, demo, finish line, copy-sent, verify and reopen", async () => {
    const f = await fixture();
    const raw = new DatabaseSync(`${f.home}/pcc.db`);
    raw.exec("INSERT INTO projects VALUES('p1','/w/acme','Acme','2026-01-01','2026-01-01'); INSERT INTO projects VALUES('p2','/w/beta','Beta','2026-01-01','2026-01-01')");
    raw.close();
    const P = "/api/intel/projects/p1";

    // Unknown project, then the finish-line gate: nothing schedule-shaped works until it is confirmed.
    expect((await f.send("PUT", "/api/intel/projects/nope/schedule", { targetDate: "2026-11-30" })).statusCode).toBe(404);
    expect((await f.send("PUT", `${P}/schedule`, { targetDate: "2026-11-30" })).statusCode).toBe(409);
    expect((await f.send("POST", `${P}/steps`, { step: "live", reached: true })).statusCode).toBe(409);
    expect((await f.send("POST", `${P}/demo`, {})).statusCode).toBe(409);
    const unconfirmed = (await f.get(P)).json();
    expect(unconfirmed.plan.moves.map((m: { kind: string }) => m.kind)).toEqual(["confirm_finish_line"]);

    const put = await f.send("PUT", `${P}/outcome`, { desiredOutcome: "Clinic staff book online", acceptanceCriteria: [], targetDate: "2026-11-30" });
    expect(put.statusCode).toBe(200);
    expect(put.json().plan.progress).toMatchObject({ confirmed: true, targetDate: "2026-11-30" });
    expect((await f.send("PUT", `${P}/outcome`, { desiredOutcome: "x", acceptanceCriteria: [], targetDate: "2026-02-31" })).statusCode).toBe(400);

    // Schedule.
    expect((await f.send("PUT", `${P}/schedule`, { targetDate: "2026-12-15", startDate: "2026-10-01" })).json().plan.progress).toMatchObject({ targetDate: "2026-12-15", startDate: "2026-10-01" });
    expect((await f.send("PUT", `${P}/schedule`, { targetDate: "2026-02-31" })).statusCode).toBe(400);
    expect((await f.send("PUT", `${P}/schedule`, {})).statusCode).toBe(400);
    expect((await f.send("PUT", `${P}/schedule`, { targetDate: null, extra: 1 })).statusCode).toBe(400);

    // Finish line from an agreement: duplicates are skipped and counted, acceptance lines join the outcome.
    const add = await f.send("POST", `${P}/finish-line`, { items: [{ title: "Online booking form", acceptance: ["A patient can book a free slot"] }, { title: "Staff calendar view", goal: "So that staff see bookings." }], acceptance: ["Works on a phone"] });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ added: 2, skipped: 0 });
    expect(add.json().intel.outcome.acceptanceCriteria).toEqual(["Works on a phone"]);
    const again = await f.send("POST", `${P}/finish-line`, { items: [{ title: "online booking form" }, { title: "Reminder emails" }], acceptance: ["works on a phone"] });
    expect(again.json()).toMatchObject({ added: 1, skipped: 1 });
    expect(again.json().intel.outcome.acceptanceCriteria).toEqual(["Works on a phone"]);
    const items = again.json().intel.items as { id: string; title: string; lane: string; goal: string | null }[];
    expect(items.map((i) => i.lane)).toEqual(["finish_line", "finish_line", "finish_line"]);
    expect((await f.send("POST", `${P}/finish-line`, { items: [] })).statusCode).toBe(400);
    expect((await f.send("POST", `${P}/finish-line`, { items: [{ title: "" }] })).statusCode).toBe(400);
    expect((await f.send("POST", `${P}/finish-line`, { items: [{ title: "x", owner: "me" }] })).statusCode).toBe(400);
    const idOf = (title: string) => items.find((i) => i.title === title)?.id ?? "";
    const booking = idOf("Online booking form");
    const calendar = idOf("Staff calendar view");
    expect(again.json().intel.plan.ready).toHaveLength(3);

    // Copying is sending; ids from another project fail the whole call and change nothing.
    const other = (await f.send("POST", "/api/intel/projects/p2/items", { kind: "requirement", title: "Beta invoices" })).json().items[0].id as string;
    expect((await f.send("POST", `${P}/tasks/sent`, { itemIds: [booking, other], sent: true })).statusCode).toBe(400);
    expect((await f.get(P)).json().plan.sent).toEqual([]);
    expect((await f.send("POST", `${P}/tasks/sent`, { itemIds: [], sent: true })).statusCode).toBe(400);
    expect((await f.send("POST", `${P}/tasks/sent`, { itemIds: ["zzz"], sent: true })).statusCode).toBe(400);
    expect((await f.send("POST", `${P}/tasks/sent`, { itemIds: [booking], sent: "yes" })).statusCode).toBe(400);
    const sent = await f.send("POST", `${P}/tasks/sent`, { itemIds: [booking, calendar], sent: true });
    expect(sent.json().plan.sent.map((t: { itemId: string }) => t.itemId).sort()).toEqual([booking, calendar].sort());
    const back = await f.send("POST", `${P}/tasks/sent`, { itemIds: [calendar], sent: false });
    expect(back.json().plan.sent.map((t: { itemId: string }) => t.itemId)).toEqual([booking]);

    // Verify, then "Not right": the round trip clears verification and the sent mark and counts the reopen.
    const verified = await f.send("POST", `/api/intel/items/${booking}/verify`, {});
    expect(verified.statusCode).toBe(200);
    expect(verified.json().items.find((i: { id: string }) => i.id === booking)).toMatchObject({ evidenceState: "verified", status: "done" });
    expect(verified.json().plan.progress.verifiedItems).toBe(1);
    const reopened = await f.send("POST", `/api/intel/items/${booking}/reopen`, { note: "Slots show in the wrong time zone" });
    expect(reopened.json().items.find((i: { id: string }) => i.id === booking)).toMatchObject({ evidenceState: "not_implemented", status: "open", verifiedAt: null, sentAt: null, reopenCount: 1 });
    expect(reopened.json().plan.progress.verifiedItems).toBe(0);
    expect((await f.send("POST", `/api/intel/items/${ID}/verify`, {})).statusCode).toBe(404);
    expect((await f.send("POST", `/api/intel/items/${booking}/verify`, { now: true })).statusCode).toBe(400);
    expect((await f.send("POST", `/api/intel/items/${booking}/reopen`, { note: 5 })).statusCode).toBe(400);

    // Lane and goal edits; a new goal resets the "Not right" count.
    const patched = await f.send("PATCH", `/api/intel/items/${booking}`, { goal: "So that patients book in their own time zone.", lane: "phase2" });
    expect(patched.json().items.find((i: { id: string }) => i.id === booking)).toMatchObject({ lane: "phase2", goal: "So that patients book in their own time zone.", reopenCount: 0 });
    expect(patched.json().plan.extras.map((t: { itemId: string }) => t.itemId)).toEqual([booking]);
    expect((await f.send("PATCH", `/api/intel/items/${booking}`, { lane: "someday" })).statusCode).toBe(400);

    // Steps and demo.
    expect((await f.send("POST", `${P}/steps`, { step: "live", reached: true })).json().plan.progress.steps.live).toBe(true);
    expect((await f.send("POST", `${P}/steps`, { step: "production_ready", reached: true })).statusCode).toBe(400);
    expect((await f.send("POST", `${P}/demo`, {})).json().plan.progress.lastClientSeenAt).toBeTruthy();
    expect((await f.send("POST", `${P}/demo`, { when: "now" })).statusCode).toBe(400);
  });

  it("files a new client ask into a chosen lane on accept, and refuses a lane for anything else", async () => {
    const f = await fixture();
    const raw = new DatabaseSync(`${f.home}/pcc.db`);
    raw.exec("INSERT INTO projects VALUES('p1','/w/acme','Acme','2026-01-01','2026-01-01')");
    const ins = raw.prepare("INSERT INTO intel_proposals(id, project_id, kind, material, summary, item_id, patch_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run("aaaaaaaaaaaaaaaa", "p1", "new_requirement", 1, "Dark mode", "bbbbbbbbbbbbbbbb", JSON.stringify({ op: "create_item", item: { kind: "requirement", title: "Dark mode", owner: "client" } }), "pending", "2026-10-10T00:00:00Z");
    ins.run("cccccccccccccccc", "p1", "scope_change", 1, "Cut reporting", null, "{}", "pending", "2026-10-10T00:00:00Z");
    raw.close();
    expect((await f.send("POST", "/api/intel/proposals/cccccccccccccccc/accept", { lane: "extra" })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/proposals/aaaaaaaaaaaaaaaa/accept", { lane: "later" })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/proposals/aaaaaaaaaaaaaaaa/accept", { lane: "phase2" })).statusCode).toBe(200);
    const p1 = (await f.get("/api/intel/projects/p1")).json();
    expect(p1.items.find((i: { id: string }) => i.id === "bbbbbbbbbbbbbbbb")).toMatchObject({ title: "Dark mode", lane: "phase2" });
  });

  it("guards every new mutation with CSRF", async () => {
    const f = await fixture();
    const noToken = (method: "POST" | "PUT", url: string, payload: object) => f.app.inject({ method, url, headers: f.headers, payload });
    for (const [method, url, payload] of [
      ["PUT", "/api/intel/projects/p1/schedule", { targetDate: null }],
      ["POST", "/api/intel/projects/p1/steps", { step: "live", reached: true }],
      ["POST", "/api/intel/projects/p1/demo", {}],
      ["POST", "/api/intel/projects/p1/tasks/sent", { itemIds: [ID], sent: true }],
      ["POST", "/api/intel/projects/p1/finish-line", { items: [{ title: "x" }] }],
      ["POST", `/api/intel/items/${ID}/verify`, {}],
      ["POST", `/api/intel/items/${ID}/reopen`, {}],
      ["PUT", "/api/intel/projects/p1/direction", { priority: 1 }],
      ["POST", "/api/intel/projects/p1/notes", { text: "x" }],
      ["POST", `/api/intel/notes/${ID}/delete`, {}],
    ] as const) expect((await noToken(method, url, payload)).statusCode, url).toBe(403);
  });

  it("sets direction and manages notes", async () => {
    const f = await fixture();
    const raw = new DatabaseSync(`${f.home}/pcc.db`);
    raw.exec("INSERT INTO projects VALUES('p1','/w/acme','Acme','2026-01-01','2026-01-01')");
    raw.exec("INSERT INTO projects VALUES('p2','/w/beta','Beta','2026-01-01','2026-01-01')");
    raw.close();
    const dir = (id: string, payload: object) => f.send("PUT", `/api/intel/projects/${id}/direction`, payload);
    expect((await dir("p1", {})).statusCode).toBe(400);
    expect((await dir("p1", { priority: 0 })).statusCode).toBe(400);
    expect((await dir("p1", { priority: 6 })).statusCode).toBe(400);
    expect((await dir("p1", { priority: 1.5 })).statusCode).toBe(400);
    expect((await dir("p1", { priority: "1" })).statusCode).toBe(400);
    expect((await dir("p1", { bogus: 1 })).statusCode).toBe(400);
    expect((await dir("p1", { focusItemIds: ["nothex"] })).statusCode).toBe(400);
    expect((await dir("p1", { paidWhen: "x".repeat(501) })).statusCode).toBe(400);
    expect((await dir("nope", { priority: 1 })).statusCode).toBe(404);
    const other = (await f.send("POST", "/api/intel/projects/p2/items", { kind: "requirement", title: "Beta thing" })).json().items[0].id as string;
    expect((await dir("p1", { focusItemIds: [other] })).statusCode).toBe(400);
    const ok = await dir("p1", { priority: 2, paidWhen: "  Client signs off  " });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().direction).toMatchObject({ priority: 2, paidWhen: "Client signs off", focusItemIds: [] });
    expect((await dir("p1", { paidWhen: "" })).json().direction.paidWhen).toBeNull();

    expect((await f.send("POST", "/api/intel/projects/p1/notes", { text: "  " })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/projects/p1/notes", { text: "x".repeat(501) })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/projects/p1/notes", { text: "x", extra: 1 })).statusCode).toBe(400);
    expect((await f.send("POST", "/api/intel/projects/nope/notes", { text: "x" })).statusCode).toBe(404);
    const note = await f.send("POST", "/api/intel/projects/p1/notes", { text: "Booking flow first" });
    expect(note.statusCode).toBe(200);
    const body = note.json() as { note: { id: string; source: string }; intel: { direction: { notes: { id: string }[] } } };
    expect(body.note).toMatchObject({ source: "ui" });
    expect(body.intel.direction.notes.map((n) => n.id)).toEqual([body.note.id]);
    expect((await f.send("POST", "/api/intel/notes/zz/delete", {})).statusCode).toBe(400);
    expect((await f.send("POST", `/api/intel/notes/${ID}/delete`, {})).statusCode).toBe(404);
    expect((await f.send("POST", `/api/intel/notes/${body.note.id}/delete`, { x: 1 })).statusCode).toBe(400);
    expect((await f.send("POST", `/api/intel/notes/${body.note.id}/delete`, {})).json()).toEqual({ ok: true });
    expect((await f.get("/api/intel/projects/p1")).json().direction.notes).toEqual([]);
  });
});
