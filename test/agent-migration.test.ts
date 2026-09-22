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

it("upgrades a genuine v8 database additively, rolls back injected failure, and restores its backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-agent-migration-"));
  const file = path.join(home, "pcc.db");
  let db = new DatabaseSync(file);
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db);
    db.exec("INSERT INTO schema_meta VALUES(8); INSERT INTO projects VALUES('retained','/fixture/project','Retained','2026-01-01','2026-01-01'); INSERT INTO project_summaries VALUES('retained','manual','{\"note\":\"Keep my work\"}','2026-01-01',1)");
    const before = db.prepare("SELECT * FROM project_summaries").all(); db.close();
    expect(() => openDb(home, () => { throw new Error("injected"); })).toThrow("injected");
    db = new DatabaseSync(file);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 8 });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'agent_%'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM project_summaries").all()).toEqual(before); db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 9 });
    expect(db.prepare("SELECT * FROM project_summaries").all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT enabled,paused FROM agent_settings").get()).toMatchObject({ enabled: 0, paused: 1 }); db.close();
    const backup = fs.readdirSync(path.join(home, "backups"))[0]!;
    const started = performance.now(), restored = path.join(home, "restore.db");
    fs.copyFileSync(path.join(home, "backups", backup), restored); db = new DatabaseSync(restored);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 8 });
    expect(db.prepare("SELECT * FROM project_summaries").all()).toEqual(before);
    expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    console.info(`RUNTIME: agent v8 backup restored and verified in ${Math.ceil(performance.now() - started)}ms`);
  } finally { try { db.close(); } catch { /* already closed */ } fs.rmSync(home, { recursive: true, force: true }); }
});
