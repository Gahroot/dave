import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { migrateDelivery } from "../src/db/migrations/005-delivery.ts";
import { migrateDeliveryCoordination } from "../src/db/migrations/006-delivery-coordination.ts";
import { migrateEngagements } from "../src/db/migrations/007-engagements.ts";
import { migrateHandoffSentAt } from "../src/db/migrations/008-handoff-sent-at.ts";
import { migrateAgentPlatform } from "../src/db/migrations/009-agent-platform.ts";

const MEETING_TABLES = [
  "meeting_extractions", "meeting_items", "meeting_profiles", "meeting_project_rules",
  "meeting_settings", "meeting_sync_runs", "meeting_sync_state", "meetings",
];

it("upgrades a genuine v9 database additively, rolls back injected failure, and restores its backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-meetings-migration-"));
  const file = path.join(home, "pcc.db");
  let db = new DatabaseSync(file);
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db);
    db.exec("INSERT INTO schema_meta VALUES(9); INSERT INTO projects VALUES('retained','/fixture/project','Retained','2026-01-01','2026-01-01'); INSERT INTO project_summaries VALUES('retained','manual','{\"note\":\"Keep my work\"}','2026-01-01',1)");
    const before = db.prepare("SELECT * FROM project_summaries").all(); db.close();

    expect(() => openDb(home, () => { throw new Error("injected"); })).toThrow("injected");
    db = new DatabaseSync(file);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 9 });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'meeting%'").all()).toEqual([]);
    db.close();

    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 10 });
    expect(db.prepare("SELECT * FROM project_summaries").all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'meeting%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    expect(tables).toEqual(MEETING_TABLES);
    // Analysis is off and nothing is connected until the user acts.
    expect(db.prepare("SELECT auto_extract, consent_version, connected_at, history_days FROM meeting_settings").get())
      .toMatchObject({ auto_extract: 0, consent_version: null, connected_at: null, history_days: 30 });
    expect(db.prepare("SELECT key_state FROM meeting_sync_state").get()).toMatchObject({ key_state: "unknown" });
    // Recording ids are digits only, enforced by the database as well as the client.
    expect(() => db.prepare("INSERT INTO meetings(recording_id,title,created_at,status,first_seen_at,updated_at) VALUES('12a','t','2026-01-01','waiting','x','x')").run()).toThrow();
    db.close();

    const backup = fs.readdirSync(path.join(home, "backups"))[0]!;
    expect(backup.startsWith("v9-")).toBe(true);
    const restored = path.join(home, "restore.db");
    fs.copyFileSync(path.join(home, "backups", backup), restored); db = new DatabaseSync(restored);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 9 });
    expect(db.prepare("SELECT * FROM project_summaries").all()).toEqual(before);
    expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  } finally { try { db.close(); } catch { /* already closed */ } fs.rmSync(home, { recursive: true, force: true }); }
});

it("refuses to open a database written by a newer DAVE", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-meetings-newer-"));
  try {
    const db = openDb(home);
    db.exec("UPDATE schema_meta SET version = 11");
    db.close();
    expect(() => openDb(home)).toThrow("Database is newer than this application");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
