import { migrateDelivery } from "./migrations/005-delivery.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = fileURLToPath(new URL("./schema.sql", import.meta.url));

export const SCHEMA_VERSION = 5;
const ATTENTION = fileURLToPath(new URL("./migrations/004_attention.sql", import.meta.url));

/**
 * Tables from earlier versions that stored work the user was made to do:
 * per-field confirmation records, classifications, extraction caches.
 */
const DROPPED = [
  "record_fields",
  "field_evidence",
  "extraction_cache",
  "clients",
  "milestones",
  "tasks",
  "runs",
  "blockers",
  "decisions",
  "approvals",
  "evidence",
  "agent_sessions",
];

export type Db = DatabaseSync;

/** App-local rollback protection, not off-device disaster recovery. */
export function openDb(appHome: string, beforeMigrationCommit?: (db: Db) => void): Db {
  fs.mkdirSync(appHome, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(appHome, "pcc.db"));
  try {
    const existed = tableExists(db, "projects");
    const previous = readVersion(db);
    if (previous > SCHEMA_VERSION) throw new Error("Database is newer than this application");
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    if (existed && previous < SCHEMA_VERSION) {
      const backupDir = path.join(appHome, "backups");
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      db.prepare("VACUUM INTO ?").run(path.join(backupDir, `v${previous}-${randomUUID()}.db`));
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existed && previous < 3) migrate(db);
      if (existed && previous < 4 && tableExists(db, "inbox_items")) {
        db.exec(fs.readFileSync(ATTENTION, "utf8"));
      }
      // Journal mode must be configured outside the migration transaction.
      db.exec(fs.readFileSync(SCHEMA, "utf8").replace("PRAGMA journal_mode = WAL;", ""));
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbox_revision ON inbox_items(project_id, subject_key, fingerprint)");
      if (previous < 5) migrateDelivery(db);
      if (previous !== SCHEMA_VERSION) {
        db.exec("DELETE FROM schema_meta");
        db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
        beforeMigrationCommit?.(db);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

function readVersion(db: Db): number {
  if (!tableExists(db, "schema_meta")) return 0;
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

function migrate(db: Db): void {
  for (const t of DROPPED) db.exec(`DROP TABLE IF EXISTS ${t}`);
  // Snapshots and inbox rows from the setup era describe work that no longer
  // exists; they cannot be translated, so they are discarded.
  for (const t of ["adapter_issues", "snapshots", "inbox_items"]) {
    if (tableExists(db, t)) db.exec(`DELETE FROM ${t}`);
  }
  // The classification columns are dropped by rebuilding projects, but SQLite
  // makes that costly; leaving them unused is harmless and keeps ids stable.
}
