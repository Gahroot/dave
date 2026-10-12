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
import { migrateMeetings } from "../src/db/migrations/010-meetings.ts";

it("upgrades a v10 database to 11 additively", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dave-intel-migration-"));
  let db = new DatabaseSync(path.join(home, "pcc.db"));
  try {
    db.exec(fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    migrateDelivery(db); migrateDeliveryCoordination(db); migrateEngagements(db); migrateHandoffSentAt(db); migrateAgentPlatform(db); migrateMeetings(db);
    db.exec("INSERT INTO schema_meta VALUES(10); INSERT INTO projects VALUES('keep','/f/p','Keep','2026-01-01','2026-01-01')");
    db.close();
    db = openDb(home);
    expect(db.prepare("SELECT version FROM schema_meta").get()).toMatchObject({ version: 11 });
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "keep" }]);
    const t = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'intel_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(t).toEqual(["intel_changes", "intel_items", "intel_objectives", "intel_outcomes", "intel_proposals", "intel_reconcile"]);
    expect(fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith("v10-"))).toBe(true);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
