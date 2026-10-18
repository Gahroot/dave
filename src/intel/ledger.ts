/**
 * Recommendation ledger: logs every recommendation DAVE made (one open row per project plus one global row) and resolves
 * it as followed, overridden, skipped, deferred, superseded or expired. Writes only DAVE's own tables
 * (recommendation_log, recommendation_skips); reads work_progress/work_events to judge what moved.
 *
 * observe() runs inside intel's transaction; every write here uses a SAVEPOINT, so it nests safely there and is atomic
 * for direct callers too. Never throws from observe/onProgress on bad stored JSON (it is parsed defensively).
 */
import type { Db } from "../db/index.ts";
import type { ProgressReport } from "../work/types.ts";
import type { Objective } from "./types.ts";
import { hash } from "./store.ts";
import { buildReview, type ReviewDirection } from "./review.ts";
import {
  LEDGER_EXPIRY_DAYS, type ActedInput, type ActiveSkip, type LedgerApi, type LedgerBasis, type LedgerHooks, type LedgerOutcome,
  type LedgerRow, type LedgerScope, type RecommendationSnapshot, type ReviewReport, type SkipInput,
} from "./ledger-types.ts";

export type LedgerService = LedgerApi & LedgerHooks & {
  targetsFor(objectiveId: string): string[];
  /** review(days) with the owner's current project direction, so suggestions go stale once applied and do not repeat. */
  reviewWith(days: number, currentDirection: (projectId: string) => ReviewDirection | null): ReviewReport;
};

type Row = Record<string, unknown>;
type Moved = { eventId: string; projectId: string; at: string; itemIds: string[]; titles: string[]; headline: string; objectiveId: string | null };
type Close = { outcome: LedgerOutcome; basis: LedgerBasis | null; actualProjectId?: string | null; actualTitle?: string | null; actualRef?: string | null; note?: string | null };

const DAY_MS = 86_400_000;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function ledgerService(db: Db, opts: { now: () => Date; projectName: (id: string) => string | null }): LedgerService {
  function tx<T>(fn: () => T): T {
    db.exec("SAVEPOINT ledger_write");
    try { const v = fn(); db.exec("RELEASE ledger_write"); return v; }
    catch (e) { db.exec("ROLLBACK TO ledger_write; RELEASE ledger_write"); throw e; }
  }
  const mapRow = (r: Row): LedgerRow => ({
    id: String(r.id), scope: r.scope as LedgerScope, projectId: str(r.project_id), objectiveId: String(r.objective_id),
    actionKind: String(r.action_kind), title: String(r.title), targetItemIds: parse<string[]>(r.target_item_ids_json, []),
    score: Number(r.score), reasons: parse<LedgerRow["reasons"]>(r.reasons_json, []), recommendedAt: String(r.recommended_at),
    outcome: (str(r.outcome) as LedgerOutcome | null), outcomeBasis: (str(r.outcome_basis) as LedgerBasis | null), outcomeAt: str(r.outcome_at),
    actualProjectId: str(r.actual_project_id), actualTitle: str(r.actual_title), actualRef: str(r.actual_ref), note: str(r.note),
  });

  const openProjectRow = (projectId: string): LedgerRow | null => {
    const r = db.prepare("SELECT * FROM recommendation_log WHERE scope='project' AND project_id=? AND outcome IS NULL ORDER BY recommended_at DESC, id LIMIT 1").get(projectId) as Row | undefined;
    return r ? mapRow(r) : null;
  };
  const openGlobalRow = (): LedgerRow | null => {
    const r = db.prepare("SELECT * FROM recommendation_log WHERE scope='global' AND outcome IS NULL ORDER BY recommended_at DESC, id LIMIT 1").get() as Row | undefined;
    return r ? mapRow(r) : null;
  };
  const newestRow = (scope: LedgerScope, projectId: string | null): LedgerRow | null => {
    const r = (scope === "global"
      ? db.prepare("SELECT * FROM recommendation_log WHERE scope='global' ORDER BY recommended_at DESC, id LIMIT 1").get()
      : db.prepare("SELECT * FROM recommendation_log WHERE scope='project' AND project_id=? ORDER BY recommended_at DESC, id LIMIT 1").get(projectId)) as Row | undefined;
    return r ? mapRow(r) : null;
  };

  function close(row: LedgerRow, c: Close, at: string): void {
    db.prepare(`UPDATE recommendation_log SET outcome=?, outcome_basis=?, outcome_at=?, actual_project_id=?, actual_title=?, actual_ref=?, note=?
      WHERE id=? AND outcome IS NULL`).run(c.outcome, c.basis, at, c.actualProjectId ?? null, c.actualTitle ? clip(c.actualTitle) : null, c.actualRef ?? null,
      c.note ?? row.note, row.id);
  }

  function open(scope: LedgerScope, o: Objective, at: string): void {
    const id = hash("recommendation", scope, o.id, at);
    db.prepare(`INSERT OR IGNORE INTO recommendation_log(id, scope, project_id, objective_id, action_kind, title, target_item_ids_json, score, reasons_json, recommended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, scope, o.projectId, o.id, o.category, clip(o.objective), JSON.stringify([...o.targetItemIds].sort()),
      Math.round(o.score), JSON.stringify(o.scoreReasons), at);
  }

  /**
   * Work DAVE observed in [from, to], oldest first: non-failed progress reports, plus linked work events whose report is
   * not written yet. The work watcher stores events, then reconciles (which re-ranks and calls observe), and only then
   * writes reports, so without the pending events the pick you just followed would close as "superseded".
   */
  function movedBetween(from: string, to: string, projectId: string | null): Moved[] {
    const scope = projectId === null ? "" : " AND project_id = ?";
    const args = projectId === null ? [from, to] : [from, to, projectId];
    const rows = db.prepare(`SELECT event_id, project_id, at, report_json FROM work_progress WHERE at >= ? AND at <= ?${scope} ORDER BY at, event_id`).all(...args) as Row[];
    const out: Moved[] = [];
    for (const r of rows) {
      const rep = parse<Partial<ProgressReport> | null>(r.report_json, null);
      if (!rep || rep.verdict === "failed") continue;
      const adv = Array.isArray(rep.advanced) ? rep.advanced : [];
      const ev = db.prepare("SELECT objective_id FROM work_events WHERE id=?").get(String(r.event_id)) as Row | undefined;
      out.push({
        eventId: String(r.event_id), projectId: String(r.project_id), at: String(r.at), itemIds: adv.map((a) => String(a.itemId)),
        titles: adv.map((a) => String(a.title)), headline: typeof rep.headline === "string" ? rep.headline : "", objectiveId: ev ? str(ev.objective_id) : null,
      });
    }
    const pending = db.prepare(`SELECT id, project_id, observed_at, title, objective_id, item_ids_json FROM work_events
      WHERE observed_at >= ? AND observed_at <= ?${scope} AND outcome NOT IN ('failed','aborted') AND link != 'none'
        AND NOT EXISTS (SELECT 1 FROM work_progress p WHERE p.event_id = work_events.id)
      ORDER BY observed_at, id`).all(...args) as Row[];
    for (const e of pending) {
      out.push({
        eventId: String(e.id), projectId: String(e.project_id), at: String(e.observed_at), itemIds: parse<unknown[]>(e.item_ids_json, []).map(String),
        titles: [], headline: typeof e.title === "string" ? e.title : "", objectiveId: str(e.objective_id),
      });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId));
  }
  const advancesTargets = (row: LedgerRow, m: Pick<Moved, "itemIds" | "objectiveId">): boolean =>
    m.objectiveId === row.objectiveId || m.itemIds.some((id) => row.targetItemIds.includes(id));

  function skipFor(row: LedgerRow): { kind: "skip" | "defer"; reason: string | null } | null {
    const r = db.prepare("SELECT kind, reason FROM recommendation_skips WHERE objective_id=? AND created_at >= ? ORDER BY created_at DESC, action_id LIMIT 1")
      .get(row.objectiveId, row.recommendedAt) as Row | undefined;
    return r ? { kind: r.kind === "defer" ? "defer" : "skip", reason: str(r.reason) } : null;
  }

  /** How a row ends when DAVE's pick changes. */
  function resolve(row: LedgerRow, now: string): Close {
    const moved = movedBetween(row.recommendedAt, now, row.scope === "project" ? row.projectId : null);
    const hit = moved.find((m) => m.projectId === row.projectId && advancesTargets(row, m));
    if (hit) return { outcome: "followed", basis: "observed", actualProjectId: hit.projectId, actualTitle: hit.headline || hit.titles.join(", ") || null, actualRef: hit.eventId };
    const s = skipFor(row);
    if (s) return { outcome: s.kind === "defer" ? "deferred" : "skipped", basis: "explicit", note: s.reason };
    const other = row.scope === "global" ? moved.find((m) => m.projectId !== row.projectId) : moved.find((m) => m.itemIds.length > 0);
    if (other) {
      const elsewhere = row.scope === "project" ? moved.filter((m) => m.itemIds.length > 0) : [other];
      const titles = [...new Set(elsewhere.flatMap((m) => m.titles))];
      return { outcome: "overridden", basis: "observed", actualProjectId: other.projectId, actualTitle: titles.join(", ") || other.headline || null, actualRef: other.eventId };
    }
    return { outcome: "superseded", basis: null };
  }

  function expire(now: Date): void {
    const cutoff = new Date(now.getTime() - LEDGER_EXPIRY_DAYS * DAY_MS).toISOString();
    db.prepare("UPDATE recommendation_log SET outcome='expired', outcome_at=? WHERE outcome IS NULL AND recommended_at < ?").run(now.toISOString(), cutoff);
  }

  /** Open a row for this objective unless it is unchanged or it just expired untouched. */
  function track(scope: LedgerScope, projectId: string | null, cur: LedgerRow | null, obj: Objective | null, at: string, nowIso: string): void {
    if (cur && obj && cur.objectiveId === obj.id) return;
    if (cur) close(cur, resolve(cur, nowIso), nowIso);
    if (!obj) return;
    const last = cur ?? newestRow(scope, projectId);
    if (!cur && last && last.objectiveId === obj.id && last.outcome === "expired") return;
    open(scope, obj, at);
  }

  function observe(s: RecommendationSnapshot): void {
    const now = opts.now();
    const nowIso = now.toISOString();
    tx(() => {
      expire(now);
      for (const projectId of [...s.byProject.keys()].sort()) {
        track("project", projectId, openProjectRow(projectId), s.byProject.get(projectId)?.objective ?? null, s.at, nowIso);
      }
      track("global", null, openGlobalRow(), s.queue[0] ?? null, s.at, nowIso);
    });
  }

  function onProgress(r: ProgressReport): void {
    if (r.verdict === "failed") return;
    const seen = db.prepare("SELECT 1 FROM recommendation_log WHERE actual_ref=? LIMIT 1").get(r.eventId);
    if (seen) return;
    const ev = db.prepare("SELECT objective_id FROM work_events WHERE id=?").get(r.eventId) as Row | undefined;
    const m = { itemIds: r.advanced.map((a) => a.itemId), objectiveId: ev ? str(ev.objective_id) : null };
    const at = opts.now().toISOString();
    const title = r.headline || r.advanced.map((a) => a.title).join(", ") || null;
    // Only a pick that was already open when DAVE saw the work can be followed or overridden by it. A pick opened by
    // the reconcile this same work triggered (e.g. "verify" right after "build") is not credited for it.
    const openBefore = (row: LedgerRow | null): row is LedgerRow => !!row && row.recommendedAt < (r.observedAt || r.at);
    tx(() => {
      const p = openProjectRow(r.projectId);
      if (openBefore(p) && advancesTargets(p, m)) close(p, { outcome: "followed", basis: "observed", actualProjectId: r.projectId, actualTitle: title, actualRef: r.eventId }, at);
      const g = openGlobalRow();
      if (!openBefore(g)) return;
      if (g.projectId === r.projectId) {
        if (advancesTargets(g, m)) close(g, { outcome: "followed", basis: "observed", actualProjectId: r.projectId, actualTitle: title, actualRef: r.eventId }, at);
      } else {
        close(g, { outcome: "overridden", basis: "observed", actualProjectId: r.projectId, actualTitle: title ?? opts.projectName(r.projectId), actualRef: r.eventId }, at);
      }
    });
  }

  function skip(input: SkipInput): void {
    db.prepare(`INSERT INTO recommendation_skips(action_id, project_id, objective_id, kind, reason, until, fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(action_id) DO UPDATE SET project_id=excluded.project_id, objective_id=excluded.objective_id, kind=excluded.kind, reason=excluded.reason,
      until=excluded.until, fingerprint=excluded.fingerprint, created_at=excluded.created_at`)
      .run(input.actionId, input.projectId, input.objectiveId, input.kind, input.reason, input.until, input.fingerprint, opts.now().toISOString());
  }

  function activeSkips(): ActiveSkip[] {
    const now = opts.now().toISOString();
    const rows = db.prepare("SELECT * FROM recommendation_skips WHERE until IS NULL OR until > ? ORDER BY created_at, action_id").all(now) as Row[];
    return rows.map((r) => ({
      actionId: String(r.action_id), projectId: str(r.project_id), objectiveId: str(r.objective_id), kind: r.kind === "defer" ? "defer" : "skip",
      reason: str(r.reason), until: str(r.until), fingerprint: String(r.fingerprint), createdAt: String(r.created_at),
    }));
  }

  function markActed(input: ActedInput): void {
    if (input.op === "copy" || !input.objectiveId) return;
    const at = opts.now().toISOString();
    const c: Close = input.op === "skip" ? { outcome: "skipped", basis: "explicit", note: input.note }
      : input.op === "defer" ? { outcome: "deferred", basis: "explicit", note: input.note }
      : { outcome: "followed", basis: "explicit", actualProjectId: input.projectId, actualRef: `act:${input.actionId}`, note: input.note };
    tx(() => {
      const rows = (db.prepare("SELECT * FROM recommendation_log WHERE objective_id=? AND outcome IS NULL ORDER BY scope, id").all(input.objectiveId) as Row[]).map(mapRow);
      for (const row of rows) close(row, c, at);
    });
  }

  function targetsFor(objectiveId: string): string[] {
    const r = db.prepare("SELECT target_item_ids_json FROM recommendation_log WHERE objective_id=? ORDER BY recommended_at DESC, id LIMIT 1").get(objectiveId) as Row | undefined;
    return r ? parse<string[]>(r.target_item_ids_json, []) : [];
  }

  function reviewWith(days: number, currentDirection?: (projectId: string) => ReviewDirection | null): ReviewReport {
    const now = opts.now();
    const from = new Date(now.getTime() - days * DAY_MS).toISOString();
    const rows = (db.prepare("SELECT * FROM recommendation_log WHERE recommended_at >= ? ORDER BY recommended_at, id").all(from) as Row[]).map(mapRow);
    return buildReview(rows, { days, now, projectName: opts.projectName, ...(currentDirection ? { currentDirection } : {}) });
  }

  return { observe, onProgress, skip, activeSkips, markActed, targetsFor, review: (days: number) => reviewWith(days), reviewWith };
}
