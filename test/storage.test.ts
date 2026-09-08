import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/db/index.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import { emptySummary } from "../src/shared/types.ts";
import type { AttentionCandidate } from "../src/shared/types.ts";
import { AT, freshRepo, tempDir } from "./helpers.ts";

describe("own storage", () => {
  let ctx: ReturnType<typeof freshRepo>;
  let id: string;
  beforeEach(() => {
    ctx = freshRepo();
    id = ctx.repo.ensureProject("/p/alpha", "alpha", AT);
  });

  it("remembers evidence revisions, snooze, seen and inactive undo across restart", () => {
    const c: AttentionCandidate = { projectId: id, subjectKey: "task:1", fingerprint: "fp1", kind: "agent-question", title: "approval", detail: "needs your approval", evidence: [], urgency: 100, nextStep: "Inspect request" };
    const now = new Date(AT);
    ctx.repo.reconcileAttention([c], [id], AT, true);
    const first = ctx.repo.inbox(now)[0]!;
    expect(first.seenAt).toBe(AT);
    ctx.repo.attentionAction(first.id, "handled", now);
    ctx.repo.reconcileAttention([c], [id], new Date(now.getTime() + 1000).toISOString());
    expect(makeRepo(openDb(ctx.home)).inbox(now)).toEqual([]);
    ctx.repo.reconcileAttention([{ ...c, fingerprint: "fp2", detail: "changed request" }], [id], AT);
    const second = ctx.repo.inbox(now)[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.seenAt).toBeNull();
    ctx.repo.markSeen([second.id], AT);
    ctx.repo.attentionAction(second.id, "tomorrow", now);
    expect(ctx.repo.inbox(now)).toEqual([]);
    const deadline = ctx.repo.inbox(now, true).find((i) => i.id === second.id)!.snoozedUntil!;
    expect(new Date(deadline).getHours()).toBe(9);
    const reopened = openDb(ctx.home);
    expect(makeRepo(reopened).inbox(now)).toEqual([]);
    expect(makeRepo(reopened).inbox(now, true).find((i) => i.id === second.id)!.snoozedUntil).toBe(deadline);
    reopened.close();
    expect(ctx.repo.inbox(new Date(deadline))).toHaveLength(1);
    ctx.repo.reconcileAttention([], [], AT);
    expect(ctx.repo.inbox(new Date(deadline))).toHaveLength(1);
    ctx.repo.reconcileAttention([], [id], AT);
    ctx.repo.attentionAction(second.id, "undo", now);
    expect(ctx.repo.inbox(now)).toEqual([]);
    expect(ctx.repo.inbox(now, true)).toHaveLength(2);
  });

  it("maps exact legacy evidence without reviving dismissed revisions", () => {
    ctx.repo.proposeInbox({ projectId: id, kind: "agent-question", title: "approval", detail: "please confirm", dedupeKey: "agent-question:t" }, AT);
    const legacy = ctx.repo.inbox(new Date(AT))[0]!;
    ctx.repo.resolveInbox(legacy.id, "dismissed", AT);
    ctx.repo.reconcileAttention([{ projectId: id, subjectKey: "task:t", fingerprint: "fp", legacyDedupeKey: "agent-question:t", kind: "agent-question", title: "approval", detail: "please confirm", evidence: [], urgency: 100, nextStep: "Inspect request" }], [id], AT);
    expect(ctx.repo.inbox(new Date(AT))).toEqual([]);
    expect(ctx.repo.inbox(new Date(AT), true)).toHaveLength(1);
    expect(ctx.repo.inbox(new Date(AT), true)[0]).toMatchObject({ id: legacy.id, status: "dismissed", fingerprint: "fp", active: true });
  });

  it("rolls back reconciliation and snapshot writes together", () => {
    expect(() => ctx.repo.transaction(() => {
      ctx.repo.proposeInbox({ projectId: id, kind: "agent-question", title: "x", detail: "x", dedupeKey: "rollback" }, AT);
      ctx.repo.saveSnapshot({ generatedAt: AT, active: [], other: [], hidden: [], today: [], inbox: [], issues: [] });
      throw new Error("snapshot failed");
    })).toThrow("snapshot failed");
    expect(ctx.repo.inbox()).toEqual([]);
    expect(ctx.repo.latest()).toBeNull();
  });

  it("needs no user input to hold a project", () => {
    expect(ctx.repo.projects()).toHaveLength(1);
    expect(ctx.repo.override(id)).toEqual({ pinned: false, hidden: false });
    expect(ctx.repo.summary(id)).toBeNull();
  });

  it("stores and returns a generated summary with its fingerprint", () => {
    const summary = { ...emptySummary(AT), recentFocus: "wiring the API" };
    ctx.repo.saveSummary(id, "fp-1", summary);
    expect(ctx.repo.summary(id)).toMatchObject({
      fingerprint: "fp-1",
      summary: { recentFocus: "wiring the API", edited: false },
    });
  });

  it("remembers that a summary was corrected by hand", () => {
    ctx.repo.saveSummary(id, "fp-1", { ...emptySummary(AT), recentFocus: "auto" });
    ctx.repo.saveSummary(id, "fp-1", { ...emptySummary(AT), recentFocus: "mine", edited: true });
    expect(ctx.repo.summary(id)!.summary).toMatchObject({ recentFocus: "mine", edited: true });
  });

  it("records optional pin and hide flags independently", () => {
    expect(ctx.repo.setOverride(id, { pinned: true }, AT)).toEqual({ pinned: true, hidden: false });
    expect(ctx.repo.setOverride(id, { hidden: true }, AT)).toEqual({ pinned: true, hidden: true });
    expect(ctx.repo.setOverride(id, { pinned: false }, AT)).toEqual({ pinned: false, hidden: true });
  });

  it("keeps ids, summaries and overrides across reopen", () => {
    ctx.repo.saveSummary(id, "fp", { ...emptySummary(AT), completed: "shipped v1" });
    ctx.repo.setOverride(id, { pinned: true }, AT);
    const reopened = makeRepo(openDb(ctx.home));
    expect(reopened.ensureProject("/p/alpha", "alpha", AT)).toBe(id);
    expect(reopened.summary(id)!.summary.completed).toBe("shipped v1");
    expect(reopened.override(id).pinned).toBe(true);
  });

  it("keeps only the most recent snapshots", () => {
    for (let i = 0; i < 25; i++) {
      ctx.repo.saveSnapshot({
        generatedAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
        active: [],
        other: [],
        hidden: [],
        today: [],
        inbox: [],
        issues: [],
      });
    }
    expect(ctx.repo.latest()!.generatedAt).toBe(new Date(Date.parse(AT) + 24 * 1000).toISOString());
  });
});

/** Rebuilds the setup-era database, with the tables that stored manual work. */
function makeV2(appHome: string): void {
  fs.mkdirSync(appHome, { recursive: true });
  const db = new DatabaseSync(path.join(appHome, "pcc.db"));
  db.exec(`
    CREATE TABLE schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (2);
    CREATE TABLE projects (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, classification TEXT, classified_at TEXT, scanned_at TEXT);
    CREATE TABLE record_fields (project_id TEXT, field TEXT, value_json TEXT, state TEXT, source TEXT, confirmed_at TEXT, updated_at TEXT);
    CREATE TABLE field_evidence (id TEXT PRIMARY KEY, project_id TEXT, field TEXT, kind TEXT, path TEXT, detail TEXT, observed_at TEXT);
    CREATE TABLE extraction_cache (hash TEXT PRIMARY KEY, payload TEXT, created_at TEXT);
    CREATE TABLE inbox_items (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT NOT NULL, field TEXT, proposed_json TEXT, current_json TEXT, evidence_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open', dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE snapshots (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE adapter_issues (id TEXT PRIMARY KEY, snapshot_id TEXT, adapter TEXT NOT NULL, path TEXT, message TEXT NOT NULL, observed_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('keep-me', '/p/alpha', 'alpha', '${AT}', '${AT}', 'unclassified', NULL, NULL);
    INSERT INTO record_fields VALUES ('keep-me', 'client', '"Acme"', 'draft', NULL, NULL, '${AT}');
    INSERT INTO inbox_items VALUES ('i1', 'keep-me', 'new-project', 'Classify alpha', 'chore', NULL, NULL, NULL, '[]', 'open', 'k1', '${AT}', NULL);
    INSERT INTO snapshots VALUES ('s1', '${AT}', '{"projects":[]}');
  `);
  db.close();
}

function makeV3(home: string) {
  const schema = fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8")
    .replace(/resolved_at   TEXT,[\s\S]*?next_step TEXT NOT NULL DEFAULT ''/, "resolved_at   TEXT");
  const db = new DatabaseSync(path.join(home, "pcc.db"));
  db.exec(schema);
  db.exec("INSERT INTO schema_meta VALUES (3)");
  const id = "preserved-project";
  db.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(id, "/p/preserved", "preserved", AT, AT);
  db.prepare("INSERT INTO project_overrides VALUES (?,?,?,?)").run(id, 1, 1, AT);
  db.prepare("INSERT INTO project_summaries VALUES (?,?,?,?,?)").run(id, "fp", JSON.stringify({ ...emptySummary(AT), edited: true, completed: "my correction" }), AT, 1);
  db.prepare("INSERT INTO inbox_items(id,project_id,kind,title,detail,status,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("keep-inbox", id, "agent-question", "approval", "request", "dismissed", "key", AT);
  db.prepare("INSERT INTO snapshots VALUES (?,?,?)").run("keep-snapshot", AT, '{"preserved":true}');
  db.close();
  return id;
}

describe("additive v4 migration", () => {
  it("preserves outcomes, edits, IDs and snapshots; restores its consistent backup", () => {
    const home = tempDir();
    const id = makeV3(home);
    const db = openDb(home);
    expect(makeRepo(db).override(id)).toEqual({ pinned: true, hidden: true });
    expect(makeRepo(db).summary(id)!.summary.completed).toBe("my correction");
    expect(db.prepare("SELECT id,status,active FROM inbox_items").get()).toMatchObject({ id: "keep-inbox", status: "dismissed", active: 0 });
    expect(db.prepare("SELECT id FROM snapshots").get()).toMatchObject({ id: "keep-snapshot" });
    db.close();
    openDb(home).close();
    const backups = fs.readdirSync(path.join(home, "backups"));
    expect(backups).toHaveLength(1);
    const started = performance.now();
    const restored = path.join(tempDir(), "restored.db");
    fs.copyFileSync(path.join(home, "backups", backups[0]!), restored);
    const copy = new DatabaseSync(restored);
    expect(copy.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(copy.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 3 });
    expect(copy.prepare("SELECT status FROM inbox_items").get()).toMatchObject({ status: "dismissed" });
    copy.close();
    console.info(`Fixture backup restore: ${Math.ceil(performance.now() - started)}ms`);
  });

  it("aborts before migration when the native backup cannot be created", () => {
    const home = tempDir();
    makeV3(home);
    fs.writeFileSync(path.join(home, "backups"), "fixture blocks backup directory");
    expect(() => openDb(home)).toThrow();
    const db = new DatabaseSync(path.join(home, "pcc.db"));
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 3 });
    expect(db.prepare("SELECT id,status FROM inbox_items").get()).toMatchObject({ id: "keep-inbox", status: "dismissed" });
    db.close();
  });

  it("rolls back injected failure and refuses newer databases", () => {
    const home = tempDir();
    makeV3(home);
    expect(() => openDb(home, () => { throw new Error("injected"); })).toThrow("injected");
    const db = new DatabaseSync(path.join(home, "pcc.db"));
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 3 });
    expect(db.prepare("SELECT status FROM inbox_items").get()).toMatchObject({ status: "dismissed" });
    expect(db.prepare("PRAGMA table_info(inbox_items)").all().some((c) => c.name === "active")).toBe(false);
    db.exec("UPDATE schema_meta SET version = 99");
    db.close();
    expect(() => openDb(home)).toThrow("newer");
  });
});

describe("migration off the setup workflow", () => {
  it("keeps project identity but removes the manual-work tables", () => {
    const appHome = tempDir("pcc-mig-");
    makeV2(appHome);
    const db = openDb(appHome);
    for (const t of ["record_fields", "field_evidence", "extraction_cache"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t)).toBeUndefined();
    }
    const r = makeRepo(db);
    expect(r.ensureProject("/p/alpha", "alpha", AT)).toBe("keep-me");
  });

  it("clears the classification chores out of the inbox", () => {
    const appHome = tempDir("pcc-mig-");
    makeV2(appHome);
    const r = makeRepo(openDb(appHome));
    expect(r.inbox()).toEqual([]);
    expect(r.latest()).toBeNull();
  });

  it("records the new schema version and is safe to run twice", () => {
    const appHome = tempDir("pcc-mig-");
    makeV2(appHome);
    openDb(appHome);
    const db = openDb(appHome);
    const row = db.prepare("SELECT version FROM schema_meta").get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    expect(makeRepo(db).ensureProject("/p/alpha", "alpha", AT)).toBe("keep-me");
  });
});
