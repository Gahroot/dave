-- Preserve every legacy outcome; unmapped rows remain history.
ALTER TABLE inbox_items ADD COLUMN subject_key TEXT;
ALTER TABLE inbox_items ADD COLUMN fingerprint TEXT;
ALTER TABLE inbox_items ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1));
ALTER TABLE inbox_items ADD COLUMN last_observed_at TEXT;
ALTER TABLE inbox_items ADD COLUMN snoozed_until TEXT;
ALTER TABLE inbox_items ADD COLUMN seen_at TEXT;
ALTER TABLE inbox_items ADD COLUMN urgency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_items ADD COLUMN next_step TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS inbox_revision ON inbox_items(project_id, subject_key, fingerprint);
