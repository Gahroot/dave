import type { Db } from "../index.ts";

/** Additive only. Runs inside openDb's backed-up migration transaction. */
export function migrateDelivery(db: Db): void {
  db.exec(`
    CREATE TABLE delivery_context_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
      fingerprint TEXT NOT NULL
    ) STRICT;
    CREATE TABLE delivery_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      goal_json TEXT CHECK(goal_json IS NULL OR json_valid(goal_json)),
      current_plan_id TEXT,
      current_milestone_id TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id, current_plan_id) REFERENCES delivery_plans(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY(project_id, current_plan_id, current_milestone_id)
        REFERENCES delivery_milestones(project_id, plan_id, id) ON DELETE RESTRICT,
      CHECK(current_milestone_id IS NULL OR current_plan_id IS NOT NULL)
    ) STRICT;
    CREATE TABLE delivery_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES delivery_state(project_id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision > 0),
      goal_json TEXT NOT NULL CHECK(json_valid(goal_json)),
      assumptions_json TEXT NOT NULL CHECK(json_valid(assumptions_json) AND json_type(assumptions_json) = 'array'),
      created_at TEXT NOT NULL,
      UNIQUE(project_id, id), UNIQUE(project_id, revision)
    ) STRICT;
    CREATE TABLE delivery_milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 5),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      status TEXT NOT NULL CHECK(status IN ('pending','blocked','reported-complete')),
      blocked_reason TEXT CHECK(blocked_reason IS NULL OR length(trim(blocked_reason)) BETWEEN 1 AND 2000),
      completed_at TEXT,
      FOREIGN KEY(project_id, plan_id) REFERENCES delivery_plans(project_id, id) ON DELETE RESTRICT,
      UNIQUE(project_id, plan_id, id), UNIQUE(project_id, plan_id, position),
      CHECK((status = 'blocked') = (blocked_reason IS NOT NULL)),
      CHECK((status = 'reported-complete') = (completed_at IS NOT NULL))
    ) STRICT;
    CREATE TABLE delivery_dependencies (
      project_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      dependency_position INTEGER NOT NULL CHECK(dependency_position >= 0 AND dependency_position < position),
      PRIMARY KEY(project_id, plan_id, position, dependency_position),
      FOREIGN KEY(project_id, plan_id, position) REFERENCES delivery_milestones(project_id, plan_id, position) ON DELETE RESTRICT,
      FOREIGN KEY(project_id, plan_id, dependency_position) REFERENCES delivery_milestones(project_id, plan_id, position) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE delivery_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES delivery_state(project_id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision > 0),
      kind TEXT NOT NULL CHECK(kind IN ('goal','plan','complete','block','reopen')),
      plan_id TEXT,
      milestone_id TEXT,
      detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
      source TEXT NOT NULL CHECK(source = CASE WHEN kind = 'complete' THEN 'user-reported' ELSE 'user-requested' END),
      idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
      request_hash TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, revision), UNIQUE(project_id, idempotency_key), UNIQUE(project_id, revision, id),
      FOREIGN KEY(project_id, plan_id) REFERENCES delivery_plans(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY(project_id, plan_id, milestone_id) REFERENCES delivery_milestones(project_id, plan_id, id) ON DELETE RESTRICT,
      CHECK(kind != 'complete' OR (milestone_id IS NOT NULL AND plan_id IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL))
    ) STRICT;
    -- Durable generation lease: no prompt, credentials or raw provider output stored.
    -- An expired lease is abandoned, never automatically retried on restart/read.
    CREATE TABLE delivery_generation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      fingerprint TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('generate','replan','continue','retry')),
      status TEXT NOT NULL CHECK(status IN ('pending','success','error','cancelled')),
      error TEXT,
      deadline INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX delivery_generation_active ON delivery_generation(project_id) WHERE status = 'pending';
    -- Durable intent only: no model call is made inside a storage transaction.
    CREATE TABLE delivery_next_plan (
      project_id TEXT NOT NULL REFERENCES delivery_state(project_id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      completion_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','error','superseded')),
      error TEXT CHECK(error IS NULL OR length(error) <= 2000),
      PRIMARY KEY(project_id, revision),
      FOREIGN KEY(project_id, revision, completion_id) REFERENCES delivery_events(project_id, revision, id) ON DELETE RESTRICT,
      CHECK((status = 'error') = (error IS NOT NULL))
    ) STRICT;
  `);
}
