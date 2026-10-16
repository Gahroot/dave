import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openDb } from "../src/db/index.ts";
import { migrateDelivery } from "../src/db/migrations/005-delivery.ts";
import { migrateDeliveryCoordination } from "../src/db/migrations/006-delivery-coordination.ts";
import { migrateEngagements } from "../src/db/migrations/007-engagements.ts";
import { migrateHandoffSentAt } from "../src/db/migrations/008-handoff-sent-at.ts";
import { migrateAgentPlatform } from "../src/db/migrations/009-agent-platform.ts";
import { migrateMeetings } from "../src/db/migrations/010-meetings.ts";
import { migrateIntel } from "../src/db/migrations/011-intel.ts";

it("upgrades a v10 database to the current version additively", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-intel-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db);
    db.exec("INSERT INTO schema_meta VALUES(10); INSERT INTO projects VALUES('keep','/f/p','Keep','2026-01-01','2026-01-01')");
    db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: SCHEMA_VERSION });
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "keep" }]);
    const t = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'intel_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(t).toEqual(["intel_changes", "intel_items", "intel_objectives", "intel_outcomes", "intel_proposals", "intel_reconcile"]);
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v10-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("upgrades a v11 database to 12: new columns, verified and confirmed times backfilled, rows kept, backup written", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-intel-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db); migrateIntel(db);
    db.exec(`INSERT INTO schema_meta VALUES(11);
      INSERT INTO intel_items(id, project_id, kind, norm_key, title, basis, status, evidence_state, owner, last_supported_at, created_at, updated_at) VALUES
        ('v', 'p1', 'requirement', 'k1', 'Checked work', 'confirmed', 'done', 'verified', 'me', '2026-10-01', '2026-09-01', '2026-10-03T10:00:00Z'),
        ('o', 'p1', 'requirement', 'k2', 'Open work', 'inferred', 'open', 'not_implemented', 'me', '2026-10-01', '2026-09-01', '2026-10-04T10:00:00Z');
      INSERT INTO intel_outcomes(project_id, desired_outcome, basis, updated_at) VALUES ('p1', 'Clinic staff book online', 'confirmed', '2026-09-20T08:00:00Z');`);
    db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 12 });
    expect(db.prepare("SELECT id, title, lane, goal, verified_at, sent_at, reopen_count FROM intel_items ORDER BY id").all()).toEqual([
      { id: "o", title: "Open work", lane: null, goal: null, verified_at: null, sent_at: null, reopen_count: 0 },
      { id: "v", title: "Checked work", lane: null, goal: null, verified_at: "2026-10-03T10:00:00Z", sent_at: null, reopen_count: 0 },
    ]);
    expect(db.prepare("SELECT desired_outcome, confirmed_at, start_date, target_date, live_at, using_at, signed_off_at, last_demo_at FROM intel_outcomes").all()).toEqual([
      { desired_outcome: "Clinic staff book online", confirmed_at: "2026-09-20T08:00:00Z", start_date: null, target_date: null, live_at: null, using_at: null, signed_off_at: null, last_demo_at: null },
    ]);
    expect(() => db.prepare("UPDATE intel_items SET lane = 'someday' WHERE id = 'o'").run()).toThrow();
    expect(() => db.prepare("UPDATE intel_items SET reopen_count = -1 WHERE id = 'o'").run()).toThrow();
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v11-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
