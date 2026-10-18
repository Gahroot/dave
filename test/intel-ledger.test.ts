import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { openDb, type Db } from "../src/db/index.ts";
import { ledgerService, type LedgerService } from "../src/intel/ledger.ts";
import { buildReview } from "../src/intel/review.ts";
import type { Objective, ObjectiveCategory } from "../src/intel/types.ts";
import type { LedgerRow } from "../src/intel/ledger-types.ts";
import type { ProgressReport } from "../src/work/types.ts";
import { tempDir } from "./helpers.ts";
import { intelHarness } from "./intel-fixture.ts";

const NAMES: Record<string, string> = { p1: "DAVE", p2: "Acme" };
const homes: string[] = []; const dbs: Db[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

function setup() {
  const home = tempDir("dave-ledger-"); homes.push(home);
  const db = openDb(home); dbs.push(db);
  const clock = { now: new Date("2026-10-12T09:00:00.000Z") };
  const ledger = ledgerService(db, { now: () => clock.now, projectName: (id) => NAMES[id] ?? null });
  const at = (iso: string) => { clock.now = new Date(iso); };
  return { db, ledger, at };
}

function obj(id: string, projectId: string, targets: string[], category: ObjectiveCategory = "coding"): Objective {
  return {
    id, projectId, projectName: NAMES[projectId] ?? projectId, stage: "building", objective: `Do ${id}`, whyNow: "", definitionOfDone: [],
    category, blockers: [], evidence: [], targetItemIds: targets, humanOnly: false, brief: null, score: 10, scoreReasons: [], dueDate: null, uncertain: null,
  };
}
function snap(at: string, byProject: Record<string, Objective | null>, queue: Objective[]) {
  return { byProject: new Map(Object.entries(byProject).map(([k, v]) => [k, { objective: v }])), queue, trigger: "test", at };
}
function progress(db: Db, eventId: string, projectId: string, at: string, advanced: { itemId: string; title: string }[], objectiveId: string | null = null): ProgressReport {
  const report: ProgressReport = {
    eventId, projectId, projectName: NAMES[projectId] ?? projectId, at, observedAt: at, headline: `Work ${eventId}`, verdict: advanced.length ? "moved" : "no_match",
    advanced: advanced.map((a) => ({ ...a, from: { status: "open", evidenceState: "not_implemented" }, to: { status: "open", evidenceState: "implementation_observed" } })),
    stillMissing: [], finishLine: { verified: 0, observed: 0, total: 0, percentDone: 0 }, nextBefore: null, nextAfter: null, source: "git", link: objectiveId ? "explicit" : "title",
  };
  db.prepare("INSERT INTO work_events(id, project_id, source, ref, kind, outcome, title, summary, at, objective_id, item_ids_json, link, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(eventId, projectId, "git", eventId, "commit", "committed", `Work ${eventId}`, null, at, objectiveId, JSON.stringify(advanced.map((a) => a.itemId)), objectiveId ? "explicit" : "title", at);
  db.prepare("INSERT INTO work_progress(event_id, project_id, at, report_json) VALUES (?,?,?,?)").run(eventId, projectId, at, JSON.stringify(report));
  return report;
}
const rows = (db: Db) => db.prepare("SELECT scope, project_id, objective_id, outcome, outcome_basis, actual_project_id, actual_title, actual_ref, note FROM recommendation_log ORDER BY recommended_at, scope, id").all();
const proj = (db: Db, objectiveId: string) => db.prepare("SELECT * FROM recommendation_log WHERE scope='project' AND objective_id=?").get(objectiveId) as Record<string, unknown>;

function start(l: LedgerService, o: Objective, at = "2026-10-12T09:00:00.000Z") { l.observe(snap(at, { [o.projectId]: o }, [o])); }

describe("recommendation ledger: resolution matrix", () => {
  it("opens one project and one global row, does nothing when unchanged, ids deterministic", () => {
    const { db, ledger } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    start(ledger, obj("A", "p1", ["i1"]), "2026-10-12T10:00:00.000Z");
    expect(rows(db)).toHaveLength(2);
    const a = setup(); start(a.ledger, obj("A", "p1", ["i1"]));
    expect(a.db.prepare("SELECT id FROM recommendation_log ORDER BY id").all()).toEqual(db.prepare("SELECT id FROM recommendation_log ORDER BY id").all());
    expect(ledger.targetsFor("A")).toEqual(["i1"]);
  });

  it("followed explicit via markActed", () => {
    const { db, ledger } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    ledger.markActed({ actionId: "x", objectiveId: "A", projectId: "p1", op: "mark_demo", note: null });
    expect(proj(db, "A")).toMatchObject({ outcome: "followed", outcome_basis: "explicit" });
  });

  it("followed observed via onProgress and at observe time", () => {
    const { db, ledger, at } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    at("2026-10-12T11:00:00.000Z");
    const r = progress(db, "e1", "p1", "2026-10-12T10:00:00.000Z", [{ itemId: "i1", title: "Item one" }]);
    ledger.onProgress(r); ledger.onProgress(r);
    expect(proj(db, "A")).toMatchObject({ outcome: "followed", outcome_basis: "observed", actual_ref: "e1" });

    const b = setup();
    start(b.ledger, obj("B", "p1", ["i2"]));
    progress(b.db, "e2", "p1", "2026-10-12T10:00:00.000Z", [], "B"); // explicit marker, nothing advanced
    b.at("2026-10-12T12:00:00.000Z");
    start(b.ledger, obj("C", "p1", ["i3"]), "2026-10-12T12:00:00.000Z");
    expect(proj(b.db, "B")).toMatchObject({ outcome: "followed", outcome_basis: "observed" });
  });

  it("work watcher order (event stored, reconcile re-ranks, then report): the followed pick is credited, the new pick is not", () => {
    const { db, ledger, at } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    // The watcher stores the linked event first; its progress report is only written after the reconcile.
    const event = (id: string) => db.prepare(`INSERT INTO work_events(id, project_id, source, ref, kind, outcome, title, summary, at, objective_id, item_ids_json, link, observed_at)
      VALUES (?, 'p1', 'ezcoder', ?, 'run_finished', 'completed', 'Build A', NULL, '2026-10-12T09:30:00.000Z', 'A', '["i1"]', 'explicit', '2026-10-12T10:00:00.000Z')`).run(id, id);
    event("e1"); event("e2");
    at("2026-10-12T10:00:00.000Z");
    // The reconcile inside the poll re-ranks: "verify A" replaces "build A" before any report exists.
    start(ledger, obj("V", "p1", ["i1"], "testing"), "2026-10-12T10:00:00.000Z");
    expect(proj(db, "A")).toMatchObject({ outcome: "followed", outcome_basis: "observed", actual_ref: "e1" });
    // Then the reports arrive. Neither may close the pick that this same work produced.
    const report = (id: string): ProgressReport => ({
      eventId: id, projectId: "p1", projectName: "DAVE", at: "2026-10-12T09:30:00.000Z", observedAt: "2026-10-12T10:00:00.000Z", headline: "Build A", verdict: "moved",
      advanced: [{ itemId: "i1", title: "Item one", from: { status: "open", evidenceState: "not_implemented" }, to: { status: "open", evidenceState: "implementation_observed" } }],
      stillMissing: [], finishLine: { verified: 0, observed: 1, total: 1, percentDone: 0 }, nextBefore: null, nextAfter: null, source: "ezcoder", link: "explicit",
    });
    ledger.onProgress(report("e1")); ledger.onProgress(report("e2"));
    expect(proj(db, "V")).toMatchObject({ outcome: null });
  });

  it("skipped and deferred", () => {
    const { db, ledger, at } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    ledger.skip({ actionId: "act1", projectId: "p1", objectiveId: "A", kind: "skip", reason: "Not now", until: null, fingerprint: "f1" });
    at("2026-10-12T10:00:00.000Z");
    start(ledger, obj("B", "p1", ["i2"]), "2026-10-12T10:00:00.000Z");
    expect(proj(db, "A")).toMatchObject({ outcome: "skipped", outcome_basis: "explicit", note: "Not now" });
    ledger.markActed({ actionId: "act2", objectiveId: "B", projectId: "p1", op: "defer", note: "Next week" });
    expect(proj(db, "B")).toMatchObject({ outcome: "deferred", outcome_basis: "explicit" });
  });

  it("overridden observed when other items in the project moved, else superseded", () => {
    const { db, ledger, at } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    progress(db, "e1", "p1", "2026-10-12T10:00:00.000Z", [{ itemId: "i9", title: "Other thing" }]);
    at("2026-10-12T11:00:00.000Z");
    start(ledger, obj("B", "p1", ["i2"]), "2026-10-12T11:00:00.000Z");
    expect(proj(db, "A")).toMatchObject({ outcome: "overridden", outcome_basis: "observed", actual_project_id: "p1", actual_title: "Other thing", actual_ref: "e1" });
    at("2026-10-12T12:00:00.000Z");
    start(ledger, obj("C", "p1", ["i3"]), "2026-10-12T12:00:00.000Z");
    expect(proj(db, "B")).toMatchObject({ outcome: "superseded", outcome_basis: null });
  });

  it("expires rows open longer than 14 days and does not reopen the same pick", () => {
    const { db, ledger, at } = setup();
    start(ledger, obj("A", "p1", ["i1"]));
    at("2026-10-27T09:00:00.000Z");
    start(ledger, obj("A", "p1", ["i1"]), "2026-10-27T09:00:00.000Z");
    expect(proj(db, "A")).toMatchObject({ outcome: "expired" });
    expect(rows(db)).toHaveLength(2);
  });

  it("global row: work on another project closes it as overridden", () => {
    const { db, ledger, at } = setup();
    const a = obj("A", "p1", ["i1"]); const b = obj("B", "p2", ["j1"]);
    ledger.observe(snap("2026-10-12T09:00:00.000Z", { p1: a, p2: b }, [a, b]));
    at("2026-10-12T11:00:00.000Z");
    ledger.onProgress(progress(db, "e1", "p2", "2026-10-12T10:00:00.000Z", [{ itemId: "j7", title: "Acme invoice" }]));
    const g = db.prepare("SELECT * FROM recommendation_log WHERE scope='global'").get();
    expect(g).toMatchObject({ outcome: "overridden", outcome_basis: "observed", actual_project_id: "p2", actual_ref: "e1" });
    expect(proj(db, "A").outcome).toBeNull();
  });

  it("skip lapses: defers past until drop out; fingerprint check stays with the caller", () => {
    const { ledger, at } = setup();
    ledger.skip({ actionId: "s1", projectId: "p1", objectiveId: "A", kind: "skip", reason: null, until: null, fingerprint: "f1" });
    ledger.skip({ actionId: "d1", projectId: "p1", objectiveId: "B", kind: "defer", reason: null, until: "2026-10-13T00:00:00.000Z", fingerprint: "f2" });
    expect(ledger.activeSkips().map((s) => s.actionId)).toEqual(["d1", "s1"]);
    at("2026-10-14T00:00:00.000Z");
    expect(ledger.activeSkips().map((s) => s.actionId)).toEqual(["s1"]);
    // Caller rule: a skip applies only while its fingerprint matches the current action's fingerprint.
    const current = { actionId: "s1", fingerprint: "f1-changed" };
    expect(ledger.activeSkips().filter((s) => s.actionId === current.actionId && s.fingerprint === current.fingerprint)).toHaveLength(0);
  });
});

describe("buildReview", () => {
  const row = (i: number, p: Partial<LedgerRow>): LedgerRow => ({
    id: `r${i}`, scope: "project", projectId: "p1", objectiveId: `o${i}`, actionKind: "build", title: `Pick ${i}`, targetItemIds: [], score: 1, reasons: [],
    recommendedAt: `2026-10-0${i}T09:00:00.000Z`, outcome: null, outcomeBasis: null, outcomeAt: null, actualProjectId: null, actualTitle: null, actualRef: null, note: null, ...p,
  });
  const fixed: LedgerRow[] = [
    row(1, { outcome: "followed", outcomeBasis: "explicit", outcomeAt: "2026-10-01T10:00:00.000Z" }),
    row(2, { outcome: "overridden", outcomeBasis: "observed", outcomeAt: "2026-10-02T10:00:00.000Z", actualProjectId: "p2", actualRef: "e2" }),
    row(3, { outcome: "overridden", outcomeBasis: "observed", outcomeAt: "2026-10-03T10:00:00.000Z", actualProjectId: "p2", actualRef: "e3" }),
    row(4, { outcome: "overridden", outcomeBasis: "observed", outcomeAt: "2026-10-04T10:00:00.000Z", actualProjectId: "p2", actualRef: "e4", note: "Client call" }),
    row(5, { actionKind: "chase", outcome: "skipped", outcomeBasis: "explicit", outcomeAt: "2026-10-05T10:00:00.000Z" }),
    row(6, { actionKind: "chase", outcome: "skipped", outcomeBasis: "explicit", outcomeAt: "2026-10-06T10:00:00.000Z" }),
    row(7, { actionKind: "chase", outcome: "superseded" }),
    row(8, {}),
  ];
  const opts = { days: 30, now: new Date("2026-10-12T00:00:00.000Z"), projectName: (id: string) => NAMES[id] ?? null };

  it("computes totals, rate, kinds, overrides, patterns and suggestions deterministically", () => {
    const r = buildReview(fixed, opts);
    expect(r.totals).toEqual({ open: 1, followed: 1, overridden: 3, skipped: 2, deferred: 0, superseded: 1, expired: 0 });
    expect(r.agreementRate).toBeCloseTo(1 / 6, 3);
    expect(r.byKind).toEqual([{ kind: "build", followed: 1, total: 4 }, { kind: "chase", followed: 0, total: 3 }]);
    expect(r.byProject).toEqual([{ projectId: "p1", projectName: "DAVE", followed: 1, overridden: 3, total: 7 }]);
    expect(r.overrides[0]).toMatchObject({ recommended: "DAVE: Pick 6", actual: "Skipped", basis: "explicit" });
    expect(r.overrides.find((o) => o.reason === "Client call")).toMatchObject({ actual: "Acme", basis: "observed" });
    expect(r.patterns).toEqual(["You skipped 2 of 3 chase recommendations", "You worked on Acme instead of DAVE's pick 3 times"]);
    expect(r.suggestions).toEqual([{ id: "set_priority:p2:2", text: expect.stringContaining("Acme"), op: { op: "set_priority", projectId: "p2", priority: 2 } }]);
    expect(buildReview([...fixed].reverse(), opts)).toEqual(r);
    expect(buildReview(fixed, { ...opts, currentDirection: () => ({ priority: 1, updatedAt: null }) }).suggestions).toEqual([]);
    // Overrides from before the owner last changed that project's direction were already acted on: no repeat bump.
    expect(buildReview(fixed, { ...opts, currentDirection: () => ({ priority: 2, updatedAt: "2026-10-04T12:00:00.000Z" }) }).suggestions).toEqual([]);
    expect(buildReview(fixed, { ...opts, currentDirection: () => ({ priority: 3, updatedAt: "2026-10-01T12:00:00.000Z" }) }).suggestions)
      .toEqual([{ id: "set_priority:p2:2", text: expect.stringContaining("since you last changed its direction"), op: { op: "set_priority", projectId: "p2", priority: 2 } }]);
    expect(buildReview([], opts).agreementRate).toBeNull();
  });

  it("names objective categories in plain words, never internal ids", () => {
    const skipped = (i: number) => row(i, { actionKind: "client_action", outcome: "skipped", outcomeBasis: "explicit", outcomeAt: `2026-10-0${i}T10:00:00.000Z` });
    expect(buildReview([skipped(1), skipped(2)], opts).patterns).toEqual(["You skipped 2 of 2 client follow-up recommendations"]);
  });
});

describe("ledger with intel (onRecommendations hook)", () => {
  it("records a row per project and a global row when intel reconciles", async () => {
    const box: { ledger: LedgerService | null } = { ledger: null };
    const h = intelHarness([{ id: "p1", name: "DAVE" }], { onRecommendations: (s) => box.ledger?.observe(s) });
    try {
      box.ledger = ledgerService(h.db, { now: () => new Date("2026-10-12T09:00:00.000Z"), projectName: (id) => NAMES[id] ?? null });
      h.addItem({ id: "m1", recordingId: "1", text: "I'll send the Acme invoice export by Friday" });
      await h.intel.reconcile("p1");
      const logged = h.db.prepare("SELECT scope, project_id, outcome FROM recommendation_log ORDER BY scope").all();
      expect(h.intel.focus().top).not.toBeNull();
      expect(logged).toEqual([{ scope: "global", project_id: "p1", outcome: null }, { scope: "project", project_id: "p1", outcome: null }]);
      expect(box.ledger.review(30).totals.open).toBe(logged.length);
    } finally { h.close(); }
  });
});
