import type { Db } from "../index.ts";

export function migrateAgentPlatform(db: Db): void {
  db.exec(`
    CREATE TABLE agent_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
      max_concurrent INTEGER NOT NULL DEFAULT 2 CHECK(max_concurrent BETWEEN 1 AND 6),
      max_per_project INTEGER NOT NULL DEFAULT 1 CHECK(max_per_project BETWEEN 1 AND 3),
      review_limit INTEGER NOT NULL DEFAULT 3 CHECK(review_limit BETWEEN 1 AND 12),
      timeout_minutes INTEGER NOT NULL DEFAULT 30 CHECK(timeout_minutes BETWEEN 1 AND 120)
    );
    INSERT INTO agent_settings(id) VALUES(1);
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      request_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
      title TEXT NOT NULL, prompt TEXT NOT NULL, criteria_json TEXT NOT NULL, checks_json TEXT NOT NULL,
      handoff_id TEXT REFERENCES delivery_handoffs(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('queued','starting','running','waiting','review','checking','accepted','failed','stopped','interrupted')),
      revision INTEGER NOT NULL DEFAULT 0, workspace TEXT, branch TEXT NOT NULL UNIQUE, base TEXT,
      session_id TEXT, turn INTEGER NOT NULL DEFAULT 0, next_prompt TEXT NOT NULL,
      permission_json TEXT, packet_json TEXT, reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX agent_handoff ON agent_runs(handoff_id) WHERE handoff_id IS NOT NULL;
    CREATE INDEX agent_dispatch ON agent_runs(status,created_at);
    CREATE TABLE agent_dependencies (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
      depends_on TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
      PRIMARY KEY(run_id,depends_on), CHECK(run_id != depends_on)
    );
    CREATE TABLE agent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX agent_event_cursor ON agent_events(run_id,seq);
    CREATE TABLE agent_packets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
      turn INTEGER NOT NULL, fingerprint TEXT NOT NULL, packet_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX agent_packet_history ON agent_packets(run_id,id);
    CREATE TABLE agent_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK(action IN ('accept','return')), fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
