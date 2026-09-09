import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { repo as portfolioRepo } from "../src/db/repo.ts";
import { deliveryRepo, DeliveryError } from "../src/db/delivery-repo.ts";
import type { DeliveryGoal, DeliveryPlanDraft, DeliveryState } from "../src/model/delivery-schema.ts";
import { AT, NOW, tempDir } from "./helpers.ts";

const homes: string[] = [];
const connections = new Set<DatabaseSync>();
function home() { const dir = tempDir("dave-delivery-"); homes.push(dir); return dir; }
function open(dir: string) { const db = openDb(dir); connections.add(db); return db; }
function close(db: DatabaseSync) { db.close(); connections.delete(db); }
afterEach(() => {
  for (const db of connections) db.close();
  connections.clear();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const goal: DeliveryGoal = { goal: "Daily guided client onboarding", intendedUser: "Invited client", workflow: "Complete onboarding without staff help", stage: "Private prototype", provider: null, model: null, consent: null };
const draft: DeliveryPlanDraft = {
  assumptions: ["No client access is available; runtime evidence uses synthetic accounts."],
  milestones: ["Guided onboarding", "Staff review workflow", "Daily operational recovery"].map((title, i) => ({
    title, outcome: `Users can complete ${title.toLowerCase()}.`, whyNow: "A coherent prerequisite for daily use.",
    scope: ["Integrated workflow", "Persisted progress and error recovery"], exclusions: ["No production writes"],
    acceptance: ["A synthetic user completes the full workflow", "Progress survives a process restart"],
    sourceIds: ["approved-goal"], humanPrerequisites: [], dependencies: i ? [i - 1] : [],
  })),
};
const report = { outcome: "Delivered the integrated workflow", evidence: "Synthetic runtime walkthrough; no client acceptance claimed." };
function setup() {
  const dir = home(), db = open(dir), repo = deliveryRepo(db, () => NOW);
  const projectId = portfolioRepo(db).ensureProject("/synthetic/delivery", "Delivery", AT);
  let state = repo.saveGoal(projectId, 0, goal);
  state = repo.savePlan(projectId, state.revision, draft);
  return { dir, db, repo, projectId, state };
}
function conflict(fn: () => unknown, state: DeliveryState) {
  try { fn(); throw new Error("Expected a conflict"); }
  catch (error) {
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error).toMatchObject({ code: "conflict", state });
  }
}

/** Genuine v4 DB created from the pre-v5 schema, not a downgraded v5 DB. */
function restoredV4() {
  const originalHome = home(), restoredHome = home();
  const db = new DatabaseSync(path.join(originalHome, "pcc.db"));
  db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO schema_meta VALUES (4)");
  db.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run("preserved", "/synthetic/old", "Saved project", AT, AT);
  db.prepare("INSERT INTO project_overrides VALUES (?,?,?,?)").run("preserved", 1, 1, AT);
  db.prepare("INSERT INTO project_summaries VALUES (?,?,?,?,?)").run("preserved", "manual-policy", '{"edited":true,"unfinished":"Do not contact clients"}', AT, 1);
  db.prepare("INSERT INTO inbox_items(id,project_id,kind,title,detail,status,dedupe_key,created_at,active) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("saved-attention", "preserved", "agent-question", "Saved question", "Saved history", "dismissed", "old-key", AT, 0);
  db.prepare("INSERT INTO snapshots VALUES (?,?,?)").run("saved-snapshot", AT, '{"historical":true}');
  const backup = path.join(originalHome, "fixture-backup.db");
  db.prepare("VACUUM INTO ?").run(backup);
  db.exec("UPDATE project_summaries SET payload = 'post-backup mutation' WHERE project_id = 'preserved'");
  db.close();
  const start = performance.now();
  fs.copyFileSync(backup, path.join(restoredHome, "pcc.db"));
  const restored = new DatabaseSync(path.join(restoredHome, "pcc.db"));
  try {
    expect(restored.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 4 });
    expect(restored.prepare("SELECT payload FROM project_summaries").get()).toMatchObject({ payload: '{"edited":true,"unfinished":"Do not contact clients"}' });
    expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  } finally { restored.close(); }
  console.info(`RUNTIME: disposable v4 restore verified in ${Math.ceil(performance.now() - start)}ms`);
  return restoredHome;
}

describe("additive delivery v5 migration", () => {
  it("migrates a restored v4 database while preserving every pre-existing table", () => {
    const dir = restoredV4();
    const old = new DatabaseSync(path.join(dir, "pcc.db"));
    const tables = ["projects", "project_overrides", "project_summaries", "inbox_items", "snapshots", "project_aliases", "project_signals", "adapter_issues"];
    const before = tables.map((t) => old.prepare(`SELECT * FROM ${t}`).all());
    old.close();
    const db = open(dir);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 6 });
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(deliveryRepo(db).read("preserved")).toMatchObject({ revision: 0, goal: null, plans: [], history: [] });
    close(db);
    close(open(dir));
    const backups = fs.readdirSync(path.join(dir, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(path.join(dir, "backups", backups[0]!));
    try { expect(backup.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 4 }); }
    finally { backup.close(); }
  });

  it("rolls all v5 tables and the version back on migration failure", () => {
    const dir = restoredV4();
    expect(() => openDb(dir, () => { throw new Error("injected migration failure"); })).toThrow("injected migration failure");
    const db = new DatabaseSync(path.join(dir, "pcc.db"));
    try {
      expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 4 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'delivery_%'").all()).toEqual([]);
      expect(db.prepare("SELECT id FROM inbox_items").get()).toMatchObject({ id: "saved-attention" });
    } finally { db.close(); }
    close(open(dir));
  });
});

describe("transactional delivery storage", () => {
  it("persists goals, plans, report evidence and next selection after an actual close/reopen", () => {
    const { dir, db, repo, projectId, state } = setup();
    const result = repo.complete(projectId, state.revision, state.currentMilestoneId!, "completion-1", report);
    expect(result.duplicate).toBe(false);
    expect(result.state.currentMilestoneId).toBe(state.plans[0]!.milestones[1]!.id);
    expect(result.state.plans[0]!.milestones[0]).toMatchObject({ status: "reported-complete", completedAt: AT });
    expect(result.state.history.at(-1)).toMatchObject({ kind: "complete", detail: report, source: "user-reported", milestoneId: state.currentMilestoneId });
    close(db);
    const reopened = deliveryRepo(open(dir), () => NOW);
    expect(reopened.read(projectId)).toEqual(result.state);
    expect(reopened.complete(projectId, state.revision, state.currentMilestoneId!, "completion-1", report)).toEqual({ state: result.state, duplicate: true });
  });

  it("rejects stale revisions, wrong current IDs, cross-project IDs, and changed retry payloads", () => {
    const { db, repo, projectId, state } = setup();
    const other = portfolioRepo(db).ensureProject("/synthetic/other", "Other", AT);
    const result = repo.complete(projectId, state.revision, state.currentMilestoneId!, "key", report).state;
    conflict(() => repo.saveGoal(projectId, state.revision, goal), result);
    conflict(() => repo.complete(projectId, state.revision, state.currentMilestoneId!, "different-key", report), result);
    conflict(() => repo.complete(projectId, result.revision, state.currentMilestoneId!, "wrong-current", report), result);
    conflict(() => repo.complete(projectId, state.revision, state.currentMilestoneId!, "key", { ...report, evidence: "Different evidence" }), result);
    conflict(() => repo.complete(other, 0, result.currentMilestoneId!, "cross-project", report), repo.read(other));
    expect(() => repo.saveGoal("unknown-project", 0, goal)).toThrow("Unknown project");
    expect(repo.read(projectId)).toEqual(result);
  });

  it("rolls back milestone status, evidence, selection and revision together after a write failure", () => {
    const { db, repo, projectId, state } = setup();
    db.exec("CREATE TEMP TRIGGER reject_completion BEFORE INSERT ON delivery_events WHEN NEW.kind = 'complete' BEGIN SELECT RAISE(ABORT, 'injected evidence write failure'); END;");
    expect(() => repo.complete(projectId, state.revision, state.currentMilestoneId!, "retry-after-failure", report)).toThrow("injected evidence write failure");
    expect(repo.read(projectId)).toEqual(state);
    db.exec("DROP TRIGGER reject_completion");
    const saved = repo.complete(projectId, state.revision, state.currentMilestoneId!, "retry-after-failure", report).state;
    expect(saved.revision).toBe(state.revision + 1);
    expect(saved.history.filter((e) => e.kind === "complete")).toHaveLength(1);
  });

  it("serializes two connections and never completes the next milestone on a duplicate retry", () => {
    const { dir, repo, projectId, state } = setup();
    const second = deliveryRepo(open(dir), () => NOW);
    const result = repo.complete(projectId, state.revision, state.currentMilestoneId!, "same-key", report).state;
    expect(second.complete(projectId, state.revision, state.currentMilestoneId!, "same-key", report)).toEqual({ state: result, duplicate: true });
    conflict(() => second.complete(projectId, state.revision, state.currentMilestoneId!, "another-key", report), result);
    expect(second.read(projectId).plans[0]!.milestones[1]!.status).toBe("pending");
  });

  it("keeps exhausted completion saved through next-plan failure, restart and retry", () => {
    const { dir, db, repo, projectId, state: initial } = setup();
    let state = initial;
    for (let n = 0; n < 3; n++) state = repo.complete(projectId, state.revision, state.currentMilestoneId!, `finish-${n}`, report).state;
    expect(state.currentMilestoneId).toBeNull();
    expect(state.nextPlans).toEqual([{ revision: state.revision, status: "pending", error: null }]);
    const failed = repo.nextPlanFailure(projectId, state.revision, "Provider unavailable");
    expect(failed.history).toEqual(state.history);
    close(db);
    const reopened = deliveryRepo(open(dir), () => NOW);
    expect(reopened.read(projectId)).toEqual(failed);
    const retried = reopened.retryNextPlan(projectId, state.revision);
    expect(retried.history.filter((e) => e.kind === "complete")).toHaveLength(3);
    expect(retried.revision).toBe(state.revision);
    expect(retried.nextPlans[0]!.status).toBe("pending");
    const replanned = reopened.savePlan(projectId, state.revision, draft);
    expect(replanned.plans).toHaveLength(2);
    expect(replanned.plans[0]).toEqual(state.plans[0]);
    expect(replanned.nextPlans[0]!.status).toBe("superseded");
    expect(replanned.history.at(-1)).toMatchObject({ kind: "plan", planId: replanned.currentPlanId, milestoneId: replanned.currentMilestoneId });
  });

  it("rolls final completion back if its durable continuation intent cannot be saved", () => {
    const { db, repo, projectId, state: initial } = setup();
    let state = initial;
    for (let n = 0; n < 2; n++) state = repo.complete(projectId, state.revision, state.currentMilestoneId!, `pre-${n}`, report).state;
    db.exec("CREATE TEMP TRIGGER reject_continuation BEFORE INSERT ON delivery_next_plan BEGIN SELECT RAISE(ABORT, 'injected continuation failure'); END;");
    expect(() => repo.complete(projectId, state.revision, state.currentMilestoneId!, "final", report)).toThrow("injected continuation failure");
    expect(repo.read(projectId)).toEqual(state);
    db.exec("DROP TRIGGER reject_continuation");
    expect(repo.complete(projectId, state.revision, state.currentMilestoneId!, "final", report).state.nextPlans).toHaveLength(1);
  });

  it("preserves blocked reasons and completion history across reopen and replan", () => {
    const { repo, projectId, state } = setup();
    const blocked = repo.block(projectId, state.revision, state.currentMilestoneId!, "Client access unavailable");
    expect(blocked.currentMilestoneId).toBe(state.currentMilestoneId);
    expect(blocked.plans[0]!.milestones[0]!.blockedReason).toBe("Client access unavailable");
    expect(() => repo.complete(projectId, blocked.revision, blocked.currentMilestoneId!, "blocked-key", report)).toThrow("Reopen");
    const resumed = repo.reopen(projectId, blocked.revision, blocked.currentMilestoneId!, "Use approved synthetic access instead");
    const done = repo.complete(projectId, resumed.revision, resumed.currentMilestoneId!, "done-key", report).state;
    const replanned = repo.savePlan(projectId, done.revision, draft);
    const restored = repo.reopen(projectId, replanned.revision, state.currentMilestoneId!, "Regression observed");
    expect(restored.currentPlanId).toBe(state.currentPlanId);
    expect(restored.history.filter((e) => e.kind === "complete")).toEqual(done.history.filter((e) => e.kind === "complete"));
    expect(restored.plans).toHaveLength(2);
    expect(repo.complete(projectId, resumed.revision, resumed.currentMilestoneId!, "done-key", report).duplicate).toBe(true);
    expect(repo.read(projectId).currentMilestoneId).toBe(state.currentMilestoneId);
  });

  it("validates structured input and database constraints independently", () => {
    const { db, repo, projectId, state } = setup();
    expect(() => repo.savePlan(projectId, state.revision, { ...draft, milestones: draft.milestones.slice(0, 1) })).toThrow("3–6");
    expect(() => repo.savePlan(projectId, state.revision, { ...draft, milestones: draft.milestones.map((m, i) => i ? m : { ...m, dependencies: [2] }) })).toThrow("earlier");
    expect(() => repo.savePlan(projectId, state.revision, { ...draft, milestones: draft.milestones.map((m) => ({ ...m, acceptance: [] })) })).toThrow("list size");
    expect(() => repo.complete(projectId, state.revision, state.currentMilestoneId!, "large", { ...report, evidence: "x".repeat(8001) })).toThrow("oversized");
    expect(() => repo.saveGoal(projectId, state.revision, { ...goal, provider: "claude", model: "api-billing" })).toThrow("Unsupported");
    const unexpectedCredential = { ...goal, accessToken: "synthetic-not-a-real-token" };
    expect(() => repo.saveGoal(projectId, state.revision, unexpectedCredential)).toThrow("Unexpected");
    expect(() => db.prepare("UPDATE delivery_milestones SET status = 'verified' WHERE id = ?").run(state.currentMilestoneId!)).toThrow();
    expect(() => db.prepare("UPDATE delivery_state SET current_milestone_id = 'unknown' WHERE project_id = ?").run(projectId)).toThrow();
    expect(() => db.prepare("INSERT INTO delivery_dependencies VALUES (?,?,?,?)").run(projectId, state.currentPlanId!, 0, 2)).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(repo.read(projectId)).toEqual(state);
  });
});
