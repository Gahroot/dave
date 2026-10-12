import type { Db } from "../index.ts";

/**
 * Delivery Intelligence: living delivery record (outcomes, items, proposals), its change log and
 * the last objective chosen per project. Additive only; no foreign keys into portfolio tables so a
 * project vanishing from discovery never erases the stored plan (failure tolerance).
 */
export function migrateIntel(db: Db): void {
  db.exec(`
    CREATE TABLE intel_outcomes (
      project_id TEXT PRIMARY KEY,
      desired_outcome TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      stage_override TEXT,
      basis TEXT NOT NULL CHECK(basis IN ('confirmed','inferred')),
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
      provenance_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE intel_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('requirement','milestone','commitment','blocker','decision','exclusion')),
      norm_key TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      basis TEXT NOT NULL CHECK(basis IN ('confirmed','inferred')),
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','done','dropped','obsolete')),
      evidence_state TEXT NOT NULL CHECK(evidence_state IN ('not_implemented','implementation_observed','unverified','verified','blocked','unknown')),
      readiness_target TEXT,
      readiness_reached TEXT,
      owner TEXT NOT NULL CHECK(owner IN ('me','client','third_party','unknown')),
      due_date TEXT,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      depends_json TEXT NOT NULL DEFAULT '[]',
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
      provenance_json TEXT NOT NULL DEFAULT '[]',
      last_supported_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX intel_items_project ON intel_items(project_id, kind);
    CREATE TABLE intel_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      material INTEGER NOT NULL CHECK(material IN (0,1)),
      summary TEXT NOT NULL,
      detail TEXT,
      item_id TEXT,
      patch_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
      note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;
    CREATE INDEX intel_proposals_project ON intel_proposals(project_id, status);
    CREATE TABLE intel_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      item_id TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    CREATE TABLE intel_objectives (
      project_id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      score INTEGER NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      chosen_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE intel_reconcile (
      project_id TEXT PRIMARY KEY,
      reconciled_at TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
  `);
}
