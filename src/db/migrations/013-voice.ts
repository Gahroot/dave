import type { Db } from "../index.ts";

/**
 * Talk to DAVE: per-project direction (paid when, priority, what matters most now) and the notes you gave DAVE,
 * shared documents with their extracted text, voice settings, voice sessions and the voice action journal.
 * Additive only (new tables). No foreign keys into portfolio tables, so a project vanishing from discovery never
 * erases what you told DAVE.
 */
export function migrateVoice(db: Db): void {
  db.exec(`
    CREATE TABLE project_direction (
      project_id TEXT PRIMARY KEY,
      paid_when TEXT,
      priority INTEGER CHECK(priority IS NULL OR priority BETWEEN 1 AND 5),
      focus_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE direction_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      text TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('voice','ui')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX direction_notes_project ON direction_notes(project_id, created_at);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('pdf','image','text','word','rtf','html')),
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      pages INTEGER,
      text_state TEXT NOT NULL CHECK(text_state IN ('pending','ready','unavailable','failed')),
      text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX documents_project ON documents(project_id, created_at);
    CREATE TABLE voice_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      voice TEXT NOT NULL,
      model TEXT NOT NULL,
      greeting INTEGER NOT NULL CHECK(greeting IN (0,1)),
      mode TEXT NOT NULL CHECK(mode IN ('hands_free','push_to_talk')),
      sounds INTEGER NOT NULL CHECK(sounds IN (0,1)),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE voice_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      project_id TEXT,
      model TEXT NOT NULL,
      voice TEXT NOT NULL,
      end_reason TEXT,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT
    ) STRICT;
    CREATE TABLE voice_actions (
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('done','needs_confirmation','confirmed','cancelled','refused','failed')),
      summary TEXT NOT NULL,
      result_json TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY(session_id, call_id)
    ) STRICT;
    CREATE INDEX voice_actions_at ON voice_actions(at);
  `);
}
