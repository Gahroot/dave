import type { Db } from "../index.ts";

/**
 * Handoffs recorded what was sent but never when, so work that went off to a coding
 * tool and silently died looked identical to work sent a minute ago.
 *
 * Existing rows have no recoverable send time, so they are backfilled to the upgrade
 * moment rather than given an invented past: a fresh clock is honest, a fabricated
 * "sent 9 days ago" is not. The column stays nullable so a row that predates or
 * escapes the backfill reads as unknown age and is never called stale.
 *
 * Additive; openDb snapshots before, and rolls back the entire upgrade on error.
 */
export function migrateHandoffSentAt(db: Db): void {
  db.exec(`
    ALTER TABLE delivery_handoffs ADD COLUMN created_at TEXT;
    UPDATE delivery_handoffs SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
  `);
}
