import type { Db } from "../index.ts";

/** Additive; openDb snapshots before, and rolls back the entire upgrade on error. */
export function migrateDeliveryCoordination(db: Db): void {
  db.exec(`
    CREATE TABLE delivery_contracts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      goal_hash TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      resolutions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(resolutions_json)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      UNIQUE(project_id,id)
    ) STRICT;
    CREATE UNIQUE INDEX delivery_contract_active ON delivery_contracts(project_id) WHERE active=1;
    CREATE TABLE delivery_handoffs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
      contract_id TEXT NOT NULL, criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      FOREIGN KEY(project_id,plan_id,milestone_id) REFERENCES delivery_milestones(project_id,plan_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(project_id,contract_id) REFERENCES delivery_contracts(project_id,id) ON DELETE RESTRICT,
      UNIQUE(project_id,id)
    ) STRICT;
    CREATE UNIQUE INDEX delivery_handoff_active ON delivery_handoffs(project_id,plan_id,milestone_id) WHERE active=1;
    CREATE TABLE delivery_reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, handoff_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
      report_json TEXT NOT NULL CHECK(json_valid(report_json)), created_at TEXT NOT NULL,
      FOREIGN KEY(project_id,handoff_id) REFERENCES delivery_handoffs(project_id,id) ON DELETE RESTRICT,
      UNIQUE(project_id,idempotency_key), UNIQUE(project_id,id)
    ) STRICT;
    CREATE TABLE delivery_reviews (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
      report_id TEXT, action TEXT NOT NULL CHECK(action IN ('accept','return')),
      reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), created_at TEXT NOT NULL,
      FOREIGN KEY(project_id,plan_id,milestone_id) REFERENCES delivery_milestones(project_id,plan_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(project_id,report_id) REFERENCES delivery_reports(project_id,id) ON DELETE RESTRICT,
      CHECK(action != 'accept' OR report_id IS NOT NULL)
    ) STRICT;
    CREATE TABLE delivery_focus (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
    ) STRICT;
  `);
}
