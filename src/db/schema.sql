-- The command center's own store. It maintains this automatically; the user is
-- never required to fill anything in. Nothing here is written back to a project,
-- EZCoder, EZBoss or pew2.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_aliases (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  source      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path, source)
);

CREATE TABLE IF NOT EXISTS project_signals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  signal     TEXT NOT NULL,
  PRIMARY KEY (project_id, signal)
);

-- Generated automatically and reused until the underlying evidence changes.
CREATE TABLE IF NOT EXISTS project_summaries (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  -- Set when the user corrects the text by hand; regeneration then leaves it be.
  edited       INTEGER NOT NULL DEFAULT 0
);

-- Optional, lightweight user preferences. Absence is the normal case.
CREATE TABLE IF NOT EXISTS project_overrides (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Only events that genuinely need a human.
CREATE TABLE IF NOT EXISTS inbox_items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','acknowledged','dismissed')),
  dedupe_key    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  subject_key TEXT,
  fingerprint TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  last_observed_at TEXT,
  snoozed_until TEXT,
  seen_at TEXT,
  urgency INTEGER NOT NULL DEFAULT 0,
  next_step TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe ON inbox_items (dedupe_key);

CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  payload      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_issues (
  id          TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES snapshots(id) ON DELETE CASCADE,
  adapter     TEXT NOT NULL,
  path        TEXT,
  message     TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
