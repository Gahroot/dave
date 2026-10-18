import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import type { Db } from "../src/db/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { createWorkService } from "../src/work/service.ts";
import { readWorkEvidence } from "../src/work/store.ts";
import { ledgerService, type LedgerService } from "../src/intel/ledger.ts";
import { createNextService } from "../src/intel/next.ts";
import { registerNextRoutes } from "../src/server/next-routes.ts";
import type { Briefing } from "../src/intel/next-types.ts";
import { intelHarness } from "./intel-fixture.ts";
import { fakeMeetings } from "./intel-prepare-fixture.ts";
import { assistantRow, git, initRepo, runFinished, sessionHeader, userRow, workRoot, writeSession } from "./work-fixtures.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** The closed loop wired exactly as src/server/index.ts wires it, on a temp home with one git project. */
async function world() {
  const root = workRoot("dave-loop-e2e-");
  const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
  const repo = path.join(paths.home, "code", "acme");
  initRepo(repo);
  let clock = new Date("2026-10-12T09:00:00.000Z");
  const box: { db?: Db; ledger?: LedgerService } = {};
  const h = intelHarness([{ id: "p1", name: "Acme" }], {
    workEvidence: (id) => (box.db ? readWorkEvidence(box.db, id, clock) : []),
    onRecommendations: (s) => box.ledger?.observe(s),
  });
  box.db = h.db;
  const ledger = ledgerService(h.db, { now: () => clock, projectName: (id) => (id === "p1" ? "Acme" : null) });
  box.ledger = ledger;
  const work = createWorkService({ db: h.db, paths, intel: h.intel, projects: () => [{ id: "p1", name: "Acme", path: repo }], now: () => clock,
    runGh: async () => { throw new Error("GitHub is off; gh must never run"); } });
  work.onProgress((r) => ledger.onProgress(r));
  const next = createNextService({ db: h.db, intel: h.intel, meetings: fakeMeetings(), work, ledger, now: () => clock });
  const app = Fastify({ logger: false });
  registerNextRoutes(app, next);
  cleanups.push(() => { fs.rmSync(root, { recursive: true, force: true }); });
  cleanups.push(() => h.close());
  cleanups.push(() => work.close());
  cleanups.push(() => app.close());
  const tick = (iso: string) => { clock = new Date(iso); h.setNow(iso); };
  const ledgerRows = () => h.db.prepare("SELECT scope, objective_id, outcome, outcome_basis, actual_ref FROM recommendation_log ORDER BY recommended_at, scope, id").all();
  return { paths, repo, h, work, next, app, tick, ledgerRows };
}

describe("closed loop end to end", () => {
  it("a finished EZ Coder run and a trailer commit move the plan, switch the next action to verify, close the pick as followed, and reach Pew once", async () => {
    const w = await world();
    // A target date is set, so "pick a target date" is not the move; the build work is.
    w.h.intel.putOutcome("p1", { desiredOutcome: "Acme staff can export and plan bookings", acceptanceCriteria: ["Used by Acme staff"], lock: true,
      startDate: "2026-10-01", targetDate: "2026-11-30" });
    w.h.intel.addItem("p1", { kind: "requirement", title: "CSV export of bookings", acceptance: ["Export opens in Excel", "Dates use the client's timezone"] });
    w.h.intel.addItem("p1", { kind: "requirement", title: "Booking calendar view", acceptance: ["Shows a week at a time"] });
    const csv = w.h.intel.store.items("p1").find((i) => i.title === "CSV export of bookings");
    const calendar = w.h.intel.store.items("p1").find((i) => i.title === "Booking calendar view");
    const build = w.h.intel.projectIntel("p1").objective;
    if (!csv || !calendar || !build?.brief) throw new Error("fixture: expected two items and a build objective with a brief");
    expect(build.targetItemIds).toEqual([csv.id]);
    // Before any work: DAVE's pick is build, handed to EZ Coder by Pew (never by DAVE), and the ledger has it open.
    expect(w.next.next().action).toMatchObject({ kind: "build", objectiveId: build.id, primary: { op: { op: "hand_to_ezcoder" } } });
    expect(w.ledgerRows()).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "project", objective_id: build.id, outcome: null })]));
    // Pew asks once before the work, which sets its cursor.
    const before = await w.app.inject({ url: "/api/intel/briefing?caller=pew" });
    expect(before.json()).toMatchObject({ sinceSource: "default_24h", progress: [] });

    // The owner says yes; Pew starts EZ Coder with DAVE's brief as the first message. The run finishes, then a commit lands.
    w.tick("2026-10-12T09:40:00.000Z");
    writeSession(w.paths.ezcoder.sessions, "Users_x_acme", "2026-10-12T09-01-00_s1.jsonl", [
      sessionHeader("s1", w.repo), userRow(build.brief, "2026-10-12T09:01:00.000Z"),
      assistantRow("Added CSV export of bookings.", "2026-10-12T09:30:00.000Z"), runFinished(1, "completed", "2026-10-12T09:31:00.000Z"),
    ]);
    fs.writeFileSync(path.join(w.repo, "export.ts"), "export const csv = true;\n");
    git(w.repo, "add", ".");
    git(w.repo, "commit", "-qm", `Add bookings export\n\nDAVE-Objective: ${build.id}`);

    const polled = await w.work.poll();
    expect(polled).toMatchObject({ events: 2, projects: 1 });
    const events = w.work.events({});
    expect(events.map((e) => [e.source, e.link, e.objectiveId]).sort()).toEqual([["ezcoder", "explicit", build.id], ["git", "explicit", build.id]]);
    // The linked item moved, but only to implementation_observed; the other item did not move at all.
    expect(w.h.intel.store.items("p1").find((i) => i.id === csv.id)?.evidenceState).toBe("implementation_observed");
    expect(w.h.intel.store.items("p1").find((i) => i.id === calendar.id)?.evidenceState).toBe("not_implemented");
    expect(w.h.intel.store.items("p1").some((i) => i.evidenceState === "verified")).toBe(false);
    // Progress names what moved and what is still missing (the other item and every unverified acceptance check).
    const reports = w.work.progress({});
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const moved = reports.find((r) => r.advanced.some((a) => a.itemId === csv.id));
    expect(moved?.advanced).toEqual([expect.objectContaining({ itemId: csv.id, to: expect.objectContaining({ evidenceState: "implementation_observed" }) })]);
    expect(moved?.stillMissing.map((m) => m.title)).toEqual(expect.arrayContaining(["Booking calendar view", "Export opens in Excel", "Dates use the client's timezone", "Shows a week at a time"]));
    // The prepared next action switched from build to verify, with a checklist draft.
    const after = w.next.next().action;
    expect(after).toMatchObject({ kind: "verify", draft: { kind: "checklist" } });
    expect(after?.draft?.text).toContain("Export opens in Excel");
    expect(after?.targetItemIds).toContain(csv.id);
    // The ledger closed DAVE's build pick as followed (seen in the work), and the new verify pick stays open.
    const rows = w.ledgerRows() as { scope: string; objective_id: string; outcome: string | null; outcome_basis: string | null; actual_ref: string | null }[];
    expect(rows.find((r) => r.scope === "project" && r.objective_id === build.id)).toMatchObject({ outcome: "followed", outcome_basis: "observed" });
    const verifyObjective = w.h.intel.projectIntel("p1").objective;
    expect(verifyObjective?.id).not.toBe(build.id);
    expect(rows.find((r) => r.scope === "project" && r.objective_id === verifyObjective?.id)).toMatchObject({ outcome: null });

    // Pew asks: it gets the verify action and the progress since it last asked.
    w.tick("2026-10-12T09:45:00.000Z");
    const first = (await w.app.inject({ url: "/api/intel/briefing?caller=pew" })).json() as Briefing;
    expect(first).toMatchObject({ sinceSource: "last_asked", since: "2026-10-12T09:00:00.000Z", next: { kind: "verify" } });
    expect(first.progress.map((r) => r.eventId).sort()).toEqual(reports.map((r) => r.eventId).sort());
    expect(first.changedSince.workEvents).toBe(2);
    // Asking again with nothing new: no progress, still "since you last asked".
    w.tick("2026-10-12T09:50:00.000Z");
    const second = (await w.app.inject({ url: "/api/intel/briefing?caller=pew" })).json() as Briefing;
    expect(second).toMatchObject({ sinceSource: "last_asked", since: "2026-10-12T09:45:00.000Z", progress: [], next: { kind: "verify" } });
    // A second poll finds nothing new and changes nothing.
    const snapshot = w.h.snapshot();
    expect(await w.work.poll()).toEqual({ events: 0, reports: 0, projects: 0 });
    expect(w.h.snapshot()).toBe(snapshot);
  });
});
