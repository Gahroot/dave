import type { Db } from "../index.ts";

/**
 * Clean up: one row per bulk clean-up, holding every prior state so the batch can be undone.
 * Additive only (one new table). Nothing is deleted by clean-up itself; items are dropped and stay dropped.
 */
export function migrateTriage(db: Db): void {
  db.exec(`
    CREATE TABLE triage_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ui','voice')),
      action TEXT NOT NULL CHECK(action IN ('clear','done')),
      summary TEXT NOT NULL,
      count INTEGER NOT NULL,
      changes_json TEXT NOT NULL,
      undone_at TEXT
    ) STRICT;
    CREATE INDEX triage_batches_created ON triage_batches(created_at);
  `);
}
