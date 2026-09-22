import type { Db } from "../index.ts";

/**
 * Capacity used to be capped by the schema: `delivery_focus` held a single row, so
 * only one project could ever be the one you were delivering. This replaces that
 * pointer with a set of engagements, carrying the existing focus over as the first
 * active one. Additive; openDb snapshots before, and rolls back the entire upgrade on error.
 */
export function migrateEngagements(db: Db): void {
  db.exec(`
    CREATE TABLE delivery_engagements (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('active','paused')),
      started_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO delivery_engagements(project_id,state,started_at)
      SELECT project_id,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM delivery_focus;
    DROP TABLE delivery_focus;
  `);
}
