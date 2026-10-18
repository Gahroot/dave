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
import { migrateDeliveryLeverage } from "../src/db/migrations/012-delivery-leverage.ts";
import { migrateVoice } from "../src/db/migrations/013-voice.ts";
import { migrateTriage } from "../src/db/migrations/014-triage.ts";

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

it("upgrades a v11 database to the current version: new columns, verified and confirmed times backfilled, rows kept, backup written", () => {
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
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: SCHEMA_VERSION });
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

it("upgrades a v12 database to the current version: direction, documents and voice tables added, existing rows kept, backup written", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-voice-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db); migrateIntel(db); migrateDeliveryLeverage(db);
    db.exec(`INSERT INTO schema_meta VALUES(12);
      INSERT INTO intel_outcomes(project_id, desired_outcome, basis, updated_at) VALUES ('p1', 'Clinic staff book online', 'confirmed', '2026-09-20T08:00:00Z');`);
    db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: SCHEMA_VERSION });
    expect(db.prepare("SELECT project_id, desired_outcome FROM intel_outcomes").all()).toEqual([{ project_id: "p1", desired_outcome: "Clinic staff book online" }]);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('project_direction','direction_notes','documents','voice_settings','voice_sessions','voice_actions') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(["direction_notes", "documents", "project_direction", "voice_actions", "voice_sessions", "voice_settings"]);
    expect(() => db.prepare("INSERT INTO project_direction(project_id, priority, updated_at) VALUES ('p1', 6, 'x')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO direction_notes(id, text, source, created_at) VALUES ('n', 't', 'email', 'x')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO voice_settings(id, voice, model, greeting, mode, sounds, updated_at) VALUES (2, 'marin', 'm', 1, 'hands_free', 1, 'x')").run()).toThrow();
    db.prepare("INSERT INTO documents(id, name, kind, mime, size, sha256, text_state, created_at, updated_at) VALUES ('d1', 'a.pdf', 'pdf', 'application/pdf', 3, 'h', 'pending', 'x', 'x')").run();
    expect(() => db.prepare("INSERT INTO documents(id, name, kind, mime, size, sha256, text_state, created_at, updated_at) VALUES ('d2', 'b.pdf', 'pdf', 'application/pdf', 3, 'h', 'pending', 'x', 'x')").run()).toThrow();
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v12-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("upgrades a v13 database to 14: the clean-up batch table is added, existing rows kept, backup written", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-triage-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db); migrateIntel(db); migrateDeliveryLeverage(db); migrateVoice(db);
    db.exec(`INSERT INTO schema_meta VALUES(13);
      INSERT INTO direction_notes(id, project_id, text, source, created_at) VALUES ('n1', 'p1', 'Paid on sign-off', 'ui', '2026-10-01T09:00:00Z');`);
    db.close();
    db = openDb(home);
    expect(SCHEMA_VERSION).toBe(15);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 15 });
    expect(db.prepare("SELECT id, text FROM direction_notes").all()).toEqual([{ id: "n1", text: "Paid on sign-off" }]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name = 'triage_batches'").get()).toEqual({ name: "triage_batches" });
    const insert = db.prepare("INSERT INTO triage_batches(id, created_at, source, action, summary, count, changes_json) VALUES (?,?,?,?,?,?,?)");
    insert.run("tb-1", "2026-10-18T09:00:00Z", "ui", "clear", "Cleared 1 item.", 1, "[]");
    expect(() => insert.run("tb-2", "2026-10-18T09:00:00Z", "email", "clear", "x", 1, "[]")).toThrow();
    expect(() => insert.run("tb-3", "2026-10-18T09:00:00Z", "ui", "delete", "x", 1, "[]")).toThrow();
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v13-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("upgrades a v14 database to 15: voice_settings gains theme defaulting to dark, existing row kept, backup written", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-theme-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db); migrateIntel(db); migrateDeliveryLeverage(db); migrateVoice(db); migrateTriage(db);
    db.exec(`INSERT INTO schema_meta VALUES(14);
      INSERT INTO voice_settings(id, voice, model, greeting, mode, sounds, updated_at) VALUES (1, 'cedar', 'gpt-realtime-2.1', 0, 'push_to_talk', 1, '2026-10-17T09:00:00Z');`);
    db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 15 });
    expect(db.prepare("SELECT id, voice, model, greeting, mode, sounds, theme, updated_at FROM voice_settings").all()).toEqual([
      { id: 1, voice: "cedar", model: "gpt-realtime-2.1", greeting: 0, mode: "push_to_talk", sounds: 1, theme: "dark", updated_at: "2026-10-17T09:00:00Z" },
    ]);
    expect(() => db.prepare("UPDATE voice_settings SET theme = 'neon' WHERE id = 1").run()).toThrow();
    db.prepare("DELETE FROM voice_settings").run();
    expect(() => db.prepare("INSERT INTO voice_settings(id, voice, model, greeting, mode, sounds, theme, updated_at) VALUES (1, 'marin', 'm', 1, 'hands_free', 1, 'neon', 'x')").run()).toThrow();
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v14-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
