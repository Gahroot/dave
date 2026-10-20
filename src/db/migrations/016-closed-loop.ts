import type { Db } from "../index.ts";

/**
 * Closed loop: selective meetings (firm promise vs tentative idea), work events seen by the work watcher and the
 * progress report each one produced, the briefing cursor per caller, and the recommendation ledger with its skips.
 * Additive only. No foreign keys into portfolio tables, so a project vanishing from discovery never erases history
 * (same tolerance rule as 011).
 *
 * meeting_items.strength NULL = a row analysed before v16; its strength is classified by rule on read.
 * An absent work_settings row means the defaults (GitHub off).
 */
export function migrateClosedLoop(db: Db): void {
  db.exec(`
    ALTER TABLE meeting_items ADD COLUMN strength TEXT CHECK(strength IN ('firm','tentative'));
    ALTER TABLE meeting_items ADD COLUMN strength_source TEXT CHECK(strength_source IN ('model','rule','user'));
    ALTER TABLE meeting_items ADD COLUMN deliverable TEXT CHECK(deliverable IS NULL OR length(deliverable) <= 200);

    CREATE TABLE work_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ezcoder','git','github')),
      ref TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('run_finished','commit','merge','pr_merged')),
      outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','aborted','unverified','merged','committed')),
      title TEXT NOT NULL,
      summary TEXT,
      at TEXT NOT NULL,
      objective_id TEXT,
      item_ids_json TEXT NOT NULL DEFAULT '[]',
      link TEXT NOT NULL CHECK(link IN ('explicit','title','none')),
      observed_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX work_events_project ON work_events(project_id, at);
    CREATE INDEX work_events_at ON work_events(at);

    CREATE TABLE work_progress (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      at TEXT NOT NULL,
      report_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX work_progress_at ON work_progress(at);

    CREATE TABLE work_cursors (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, key)
    ) STRICT;

    CREATE TABLE work_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      github_enabled INTEGER NOT NULL DEFAULT 0 CHECK(github_enabled IN (0,1)),
      github_consented_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE briefing_cursors (
      caller TEXT PRIMARY KEY CHECK(caller IN ('pew','voice','ui')),
      last_briefed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE recommendation_log (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('project','global')),
      project_id TEXT,
      objective_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      target_item_ids_json TEXT NOT NULL DEFAULT '[]',
      score INTEGER NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      recommended_at TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('followed','overridden','skipped','deferred','superseded','expired')),
      outcome_basis TEXT CHECK(outcome_basis IN ('explicit','observed')),
      outcome_at TEXT,
      actual_project_id TEXT,
      actual_title TEXT,
      actual_ref TEXT,
      note TEXT
    ) STRICT;
    CREATE INDEX recommendation_log_open ON recommendation_log(scope, project_id, outcome);
    CREATE INDEX recommendation_log_at ON recommendation_log(recommended_at);

    CREATE TABLE recommendation_skips (
      action_id TEXT PRIMARY KEY,
      project_id TEXT,
      objective_id TEXT,
      kind TEXT NOT NULL DEFAULT 'skip' CHECK(kind IN ('skip','defer')),
      reason TEXT,
      until TEXT,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}
