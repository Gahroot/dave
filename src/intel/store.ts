import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import type {
  Basis, ChangeEntry, EvidenceState, IntelItem, ItemKind, ItemStatus, Owner, Proposal, ProposalKind, ProposalStatus,
  Provenance, ReadinessLevel, DeliveryStage, SourceHealth, Objective,
} from "./types.ts";

type Row = Record<string, unknown>;
const STOP = new Set(["the", "a", "an", "to", "of", "and", "for", "in", "on", "we", "i", "you", "will", "can", "that", "this", "with", "is", "be", "it", "our", "your", "by", "at", "as", "need", "needs", "please"]);

/** Normalised comparison key: lower-case word stems, stop words dropped, order-insensitive. */
export function normaliseKey(text: string): string {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((t) => t && !STOP.has(t)).map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
  return [...new Set(tokens)].sort().join(" ");
}
export function significantTokens(text: string): string[] {
  return normaliseKey(text).split(" ").filter(Boolean);
}
export const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
export const itemId = (projectId: string, kind: ItemKind, key: string): string => hash(projectId, kind, normaliseKey(key));

const json = <T>(v: unknown, fallback: T): T => { try { return typeof v === "string" ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export type StoredOutcome = {
  projectId: string; desiredOutcome: string; acceptanceCriteria: string[]; stageOverride: DeliveryStage | null;
  basis: Basis; locked: boolean; provenance: Provenance[]; updatedAt: string;
};
export type ObjectiveSnapshot = { projectId: string; objectiveId: string; objective: string; score: number; reasons: Objective["scoreReasons"]; chosenAt: string };
export type NewProposal = {
  projectId: string; kind: ProposalKind; material: boolean; summary: string; detail?: string | null;
  itemId?: string | null; patch?: Record<string, unknown>; provenance?: Provenance[];
};

export function mapItem(r: Row): IntelItem {
  return {
    id: String(r.id), projectId: String(r.project_id), kind: r.kind as ItemKind, title: String(r.title), detail: str(r.detail),
    basis: r.basis as Basis, status: r.status as ItemStatus, evidenceState: r.evidence_state as EvidenceState,
    readinessTarget: str(r.readiness_target) as ReadinessLevel | null, readinessReached: str(r.readiness_reached) as ReadinessLevel | null,
    owner: r.owner as Owner, dueDate: str(r.due_date), acceptance: json(r.acceptance_json, []), dependsOn: json(r.depends_json, []),
    locked: r.locked === 1, provenance: json(r.provenance_json, []), lastSupportedAt: String(r.last_supported_at),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function intelStore(db: Db, names: (projectId: string) => string = (id) => id) {
  const q = {
    item: db.prepare("SELECT * FROM intel_items WHERE id=?"),
    items: db.prepare("SELECT * FROM intel_items WHERE project_id=? ORDER BY created_at, id"),
    allItems: db.prepare("SELECT * FROM intel_items ORDER BY project_id, created_at, id"),
    insertItem: db.prepare(`INSERT INTO intel_items(id,project_id,kind,norm_key,title,detail,basis,status,evidence_state,readiness_target,readiness_reached,owner,due_date,acceptance_json,depends_json,locked,provenance_json,last_supported_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    updateItem: db.prepare("UPDATE intel_items SET title=?,detail=?,basis=?,status=?,evidence_state=?,readiness_target=?,readiness_reached=?,owner=?,due_date=?,acceptance_json=?,depends_json=?,locked=?,provenance_json=?,last_supported_at=?,updated_at=? WHERE id=?"),
    outcome: db.prepare("SELECT * FROM intel_outcomes WHERE project_id=?"),
    outcomes: db.prepare("SELECT project_id FROM intel_outcomes"),
    saveOutcome: db.prepare(`INSERT INTO intel_outcomes(project_id,desired_outcome,acceptance_json,stage_override,basis,locked,provenance_json,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET desired_outcome=excluded.desired_outcome,acceptance_json=excluded.acceptance_json,stage_override=excluded.stage_override,basis=excluded.basis,locked=excluded.locked,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at`),
    proposal: db.prepare("SELECT * FROM intel_proposals WHERE id=?"),
    proposals: db.prepare("SELECT * FROM intel_proposals WHERE project_id=? ORDER BY created_at, id"),
    pending: db.prepare("SELECT * FROM intel_proposals WHERE status='pending' ORDER BY created_at, id"),
    insertProposal: db.prepare("INSERT INTO intel_proposals(id,project_id,kind,material,summary,detail,item_id,patch_json,provenance_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)"),
    resolveProposal: db.prepare("UPDATE intel_proposals SET status=?,note=?,resolved_at=? WHERE id=?"),
    addChange: db.prepare("INSERT INTO intel_changes(project_id,at,kind,summary,item_id,sources_json) VALUES (?,?,?,?,?,?)"),
    changes: db.prepare("SELECT * FROM intel_changes WHERE project_id=? ORDER BY seq DESC LIMIT ?"),
    allChanges: db.prepare("SELECT * FROM intel_changes ORDER BY seq DESC LIMIT ?"),
    snapshot: db.prepare("SELECT * FROM intel_objectives WHERE project_id=?"),
    saveSnapshot: db.prepare(`INSERT INTO intel_objectives(project_id,objective_id,objective,score,reasons_json,chosen_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET objective_id=excluded.objective_id,objective=excluded.objective,score=excluded.score,reasons_json=excluded.reasons_json,chosen_at=excluded.chosen_at`),
    reconciled: db.prepare("SELECT * FROM intel_reconcile WHERE project_id=?"),
    allReconciled: db.prepare("SELECT * FROM intel_reconcile"),
    saveReconciled: db.prepare(`INSERT INTO intel_reconcile(project_id,reconciled_at,sources_json) VALUES (?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET reconciled_at=excluded.reconciled_at,sources_json=excluded.sources_json`),
  };

  function tx<T>(fn: () => T): T {
    db.exec("SAVEPOINT intel_write");
    try { const v = fn(); db.exec("RELEASE intel_write"); return v; }
    catch (e) { db.exec("ROLLBACK TO intel_write; RELEASE intel_write"); throw e; }
  }
  const mapProposal = (r: Row): Proposal => ({
    id: String(r.id), projectId: String(r.project_id), projectName: names(String(r.project_id)), kind: r.kind as ProposalKind,
    material: r.material === 1, summary: String(r.summary), detail: str(r.detail), itemId: str(r.item_id),
    patch: json(r.patch_json, {}), provenance: json(r.provenance_json, []), status: r.status as ProposalStatus,
    createdAt: String(r.created_at), resolvedAt: str(r.resolved_at),
  });
  const mapChange = (r: Row): ChangeEntry => ({
    id: `c${r.seq}`, projectId: str(r.project_id), at: String(r.at), kind: r.kind as ChangeEntry["kind"], summary: String(r.summary),
    itemId: str(r.item_id), sources: json(r.sources_json, []),
  });

  return {
    tx,
    item: (id: string): IntelItem | null => { const r = q.item.get(id) as Row | undefined; return r ? mapItem(r) : null; },
    items: (projectId: string): IntelItem[] => (q.items.all(projectId) as Row[]).map(mapItem),
    allItems: (): IntelItem[] => (q.allItems.all() as Row[]).map(mapItem),
    insertItem(i: IntelItem, key: string): void {
      q.insertItem.run(i.id, i.projectId, i.kind, normaliseKey(key), i.title, i.detail, i.basis, i.status, i.evidenceState, i.readinessTarget,
        i.readinessReached, i.owner, i.dueDate, JSON.stringify(i.acceptance), JSON.stringify(i.dependsOn), i.locked ? 1 : 0,
        JSON.stringify(i.provenance), i.lastSupportedAt, i.createdAt, i.updatedAt);
    },
    updateItem(i: IntelItem): void {
      q.updateItem.run(i.title, i.detail, i.basis, i.status, i.evidenceState, i.readinessTarget, i.readinessReached, i.owner, i.dueDate,
        JSON.stringify(i.acceptance), JSON.stringify(i.dependsOn), i.locked ? 1 : 0, JSON.stringify(i.provenance), i.lastSupportedAt, i.updatedAt, i.id);
    },
    outcome(projectId: string): StoredOutcome | null {
      const r = q.outcome.get(projectId) as Row | undefined;
      return r ? { projectId, desiredOutcome: String(r.desired_outcome), acceptanceCriteria: json(r.acceptance_json, []), stageOverride: str(r.stage_override) as DeliveryStage | null,
        basis: r.basis as Basis, locked: r.locked === 1, provenance: json(r.provenance_json, []), updatedAt: String(r.updated_at) } : null;
    },
    outcomeProjects: (): string[] => (q.outcomes.all() as Row[]).map((r) => String(r.project_id)),
    saveOutcome(o: StoredOutcome): void {
      q.saveOutcome.run(o.projectId, o.desiredOutcome, JSON.stringify(o.acceptanceCriteria), o.stageOverride, o.basis, o.locked ? 1 : 0, JSON.stringify(o.provenance), o.updatedAt);
    },
    proposal: (id: string): Proposal | null => { const r = q.proposal.get(id) as Row | undefined; return r ? mapProposal(r) : null; },
    proposals: (projectId: string): Proposal[] => (q.proposals.all(projectId) as Row[]).map(mapProposal),
    pendingProposals: (): Proposal[] => (q.pending.all() as Row[]).map(mapProposal),
    /** Idempotent: identical content (same id) is never proposed twice, even after it was accepted or rejected. */
    addProposal(p: NewProposal, now: string): Proposal | null {
      // Identity is the subject (item or normalised summary) plus the specific change, so rephrased repeats collapse.
      const patch = p.patch ?? {};
      const change = patch.fields ? JSON.stringify(patch.fields) : typeof patch.code === "string" ? patch.code : "";
      const id = hash("proposal", p.projectId, p.kind, p.itemId ?? normaliseKey(p.summary), change);
      if (q.proposal.get(id)) return null;
      q.insertProposal.run(id, p.projectId, p.kind, p.material ? 1 : 0, p.summary, p.detail ?? null, p.itemId ?? null,
        JSON.stringify(p.patch ?? {}), JSON.stringify(p.provenance ?? []), now);
      return mapProposal(q.proposal.get(id) as Row);
    },
    resolveProposal(id: string, status: Exclude<ProposalStatus, "pending">, note: string | null, now: string): void { q.resolveProposal.run(status, note, now, id); },
    addChange(c: { projectId: string | null; kind: ChangeEntry["kind"]; summary: string; itemId?: string | null; sources?: string[] }, now: string): void {
      q.addChange.run(c.projectId, now, c.kind, c.summary, c.itemId ?? null, JSON.stringify(c.sources ?? []));
    },
    changes: (projectId: string, limit = 50): ChangeEntry[] => (q.changes.all(projectId, limit) as Row[]).map(mapChange),
    recentChanges: (limit = 20): ChangeEntry[] => (q.allChanges.all(limit) as Row[]).map(mapChange),
    snapshot(projectId: string): ObjectiveSnapshot | null {
      const r = q.snapshot.get(projectId) as Row | undefined;
      return r ? { projectId, objectiveId: String(r.objective_id), objective: String(r.objective), score: Number(r.score), reasons: json(r.reasons_json, []), chosenAt: String(r.chosen_at) } : null;
    },
    saveSnapshot(s: ObjectiveSnapshot): void { q.saveSnapshot.run(s.projectId, s.objectiveId, s.objective, s.score, JSON.stringify(s.reasons), s.chosenAt); },
    reconciled(projectId: string): { at: string; sources: SourceHealth[] } | null {
      const r = q.reconciled.get(projectId) as Row | undefined;
      return r ? { at: String(r.reconciled_at), sources: json(r.sources_json, []) } : null;
    },
    allReconciled: (): { projectId: string; at: string }[] => (q.allReconciled.all() as Row[]).map((r) => ({ projectId: String(r.project_id), at: String(r.reconciled_at) })),
    saveReconciled(projectId: string, at: string, sources: SourceHealth[]): void { q.saveReconciled.run(projectId, at, JSON.stringify(sources)); },
  };
}
export type IntelStore = ReturnType<typeof intelStore>;
