import type { Db } from "../index.ts";

/**
 * Fathom meetings: imported transcripts (local only), DAVE's own analysis, and
 * the promises, client asks and decisions it found. Additive only.
 */
export function migrateMeetings(db: Db): void {
  db.exec(`
    CREATE TABLE meeting_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      fathom_email TEXT NOT NULL DEFAULT '' CHECK(length(fathom_email) <= 254),
      name_aliases_json TEXT NOT NULL DEFAULT '[]',
      history_days INTEGER NOT NULL DEFAULT 30 CHECK(history_days IN (7,30,90)),
      paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
      ignore_words_json TEXT NOT NULL DEFAULT '[]',
      auto_extract INTEGER NOT NULL DEFAULT 0 CHECK(auto_extract IN (0,1)),
      consent_version TEXT,
      consent_at TEXT,
      connected_at TEXT,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO meeting_settings(id) VALUES(1);
    CREATE TABLE meeting_sync_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      key_state TEXT NOT NULL DEFAULT 'unknown' CHECK(key_state IN ('unknown','valid','invalid')),
      last_success_at TEXT,
      cursor TEXT,
      cursor_since TEXT,
      -- When the interrupted listing began: its success point, so a late resume misses nothing.
      cursor_started_at TEXT,
      backoff_until TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_run_at TEXT,
      followup_at TEXT
    );
    INSERT INTO meeting_sync_state(id) VALUES(1);
    CREATE TABLE meeting_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL CHECK(trigger IN ('schedule','manual')),
      outcome TEXT NOT NULL CHECK(outcome IN ('ok','partial','error','skipped')),
      stats_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
    CREATE TABLE meetings (
      recording_id TEXT PRIMARY KEY CHECK(length(recording_id) BETWEEN 1 AND 20 AND recording_id NOT GLOB '*[^0-9]*'),
      title TEXT NOT NULL,
      calendar_title TEXT,
      url TEXT,
      share_url TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      recorded_by TEXT NOT NULL DEFAULT '',
      external INTEGER NOT NULL DEFAULT 0 CHECK(external IN (0,1)),
      attendees_json TEXT NOT NULL DEFAULT '[]',
      transcript_json TEXT,
      transcript_hash TEXT,
      transcript_bytes INTEGER,
      transcript_attempts INTEGER NOT NULL DEFAULT 0,
      transcript_next_at TEXT,
      -- 'forgotten' keeps only the recording id, so the next sync does not re-import it.
      status TEXT NOT NULL CHECK(status IN ('waiting','unavailable','skipped','imported','analyzed','failed','forgotten')),
      skip_reason TEXT,
      error TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      project_source TEXT CHECK(project_source IN ('rule','user','model')),
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX meeting_recent ON meetings(created_at DESC);
    CREATE INDEX meeting_pending ON meetings(status, transcript_next_at);
    CREATE TABLE meeting_extractions (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES meetings(recording_id) ON DELETE CASCADE,
      instructions_hash TEXT NOT NULL,
      transcript_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      stats_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX meeting_extraction_history ON meeting_extractions(recording_id, created_at DESC);
    CREATE TABLE meeting_items (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES meetings(recording_id) ON DELETE CASCADE,
      extraction_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('commitment','suggestion','pain_point','decision')),
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600),
      quote TEXT NOT NULL CHECK(length(quote) BETWEEN 1 AND 400),
      at_seconds INTEGER NOT NULL CHECK(at_seconds >= 0),
      speaker TEXT NOT NULL,
      speaker_role TEXT NOT NULL CHECK(speaker_role IN ('me','client','teammate','unknown')),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      project_source TEXT CHECK(project_source IN ('model','user','rule','meeting')),
      due_phrase TEXT,
      due_date TEXT,
      feature_json TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','planned','looks_done','done','dropped')),
      status_source TEXT NOT NULL DEFAULT 'model' CHECK(status_source IN ('model','user','evidence','meeting','agent')),
      status_note TEXT,
      status_changed_at TEXT,
      -- "Looks done?": what later evidence suggests, and which evidence, so "Not yet" can reject exactly that.
      suggested_status TEXT CHECK(suggested_status IN ('done','dropped')),
      suggested_evidence_json TEXT NOT NULL DEFAULT '[]',
      rejected_evidence_json TEXT NOT NULL DEFAULT '[]',
      evidence_seen TEXT,
      evidence_checked_at TEXT,
      edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
      agent_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX meeting_item_meeting ON meeting_items(recording_id, kind);
    CREATE INDEX meeting_item_open ON meeting_items(status, project_id);
    CREATE TABLE meeting_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('default','user')),
      instructions TEXT NOT NULL CHECK(length(instructions) <= 4000),
      created_at TEXT NOT NULL
    );
    CREATE TABLE meeting_project_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('domain','title')),
      pattern TEXT NOT NULL CHECK(length(pattern) BETWEEN 1 AND 120),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(kind, pattern)
    );
  `);
}
