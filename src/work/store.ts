import type { Db } from "../db/index.ts";
import {
  DAVE_ID, WORK_EVENT_KINDS, WORK_LINKS, WORK_OUTCOMES, WORK_SOURCES,
  type ProgressReport, type WorkEvent, type WorkEvidence, type WorkSettings, type WorkSource, type WorkSourceHealth,
} from "./types.ts";

/**
 * SQLite access for the completion loop (tables work_events, work_progress, work_cursors, work_settings). Plain
 * functions over a Db so the server can hand `readWorkEvidence` to intel before the work service exists.
 */

const DAY_MS = 86_400_000;
export const EVIDENCE_DAYS = 30;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

type EventRow = {
  id: string; project_id: string; source: string; ref: string; kind: string; outcome: string; title: string; summary: string | null;
  at: string; objective_id: string | null; item_ids_json: string; link: string; observed_at: string;
};

const pick = <T extends string>(allowed: readonly T[], v: string, fallback: T): T => allowed.find((a) => a === v) ?? fallback;

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && DAVE_ID.test(x)) : [];
  } catch { return []; }
}

function toEvent(r: EventRow): WorkEvent {
  return {
    id: r.id, projectId: r.project_id, source: pick(WORK_SOURCES, r.source, "git"), ref: r.ref, kind: pick(WORK_EVENT_KINDS, r.kind, "commit"),
    outcome: pick(WORK_OUTCOMES, r.outcome, "committed"), title: r.title, summary: r.summary, at: r.at, objectiveId: r.objective_id,
    itemIds: parseIds(r.item_ids_json), link: pick(WORK_LINKS, r.link, "none"), observedAt: r.observed_at,
  };
}

export function hasEvent(db: Db, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM work_events WHERE id=?").get(id);
}

/** Inserts once; returns false when the event id is already stored. */
export function insertEvent(db: Db, e: WorkEvent): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO work_events(id, project_id, source, ref, kind, outcome, title, summary, at, objective_id, item_ids_json, link, observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.projectId, e.source, e.ref, e.kind, e.outcome, e.title, e.summary, e.at, e.objectiveId,
    JSON.stringify([...e.itemIds].sort()), e.link, e.observedAt);
  return Number(r.changes) > 0;
}

export type WorkQuery = { since?: string; projectId?: string; limit?: number };

const clampLimit = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n) ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));

function where(q: WorkQuery): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (q.since) { parts.push("at >= ?"); args.push(q.since); }
  if (q.projectId) { parts.push("project_id = ?"); args.push(q.projectId); }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

/** Newest first. */
export function readEvents(db: Db, q: WorkQuery): WorkEvent[] {
  const w = where(q);
  return (db.prepare(`SELECT * FROM work_events ${w.sql} ORDER BY at DESC, id DESC LIMIT ?`).all(...w.args, clampLimit(q.limit)) as EventRow[]).map(toEvent);
}

const SOURCE_LABEL: Record<WorkSource, string> = { ezcoder: "EZ Coder run", git: "Commit", github: "Merged pull request" };

/**
 * Linked work events from the last 30 days as reconcile evidence. Failed and aborted runs are never evidence, and
 * events with no link are left out. Sorted by time, then id.
 */
export function readWorkEvidence(db: Db, projectId: string, now: Date): WorkEvidence[] {
  const since = new Date(now.getTime() - EVIDENCE_DAYS * DAY_MS).toISOString();
  const rows = db.prepare(`SELECT * FROM work_events WHERE project_id=? AND at >= ? AND outcome NOT IN ('failed','aborted') AND link != 'none'
    ORDER BY at, id`).all(projectId, since) as EventRow[];
  return rows.map(toEvent).map((e): WorkEvidence => ({
    id: `work:${e.id}`, kind: e.source === "ezcoder" ? "agent-task" : "git", label: `${SOURCE_LABEL[e.source]}: ${e.title}`.slice(0, 200), at: e.at,
    text: [e.title, e.summary ?? ""].join(" ").trim(), itemIds: e.itemIds,
  }));
}

/** work_progress.at is when DAVE observed the work (report.observedAt), so `since` windows never skip late-seen work. */
export function writeProgress(db: Db, r: ProgressReport): void {
  db.prepare("INSERT OR REPLACE INTO work_progress(event_id, project_id, at, report_json) VALUES (?,?,?,?)").run(r.eventId, r.projectId, r.observedAt, JSON.stringify(r));
}

/** Newest observed first, then newest work first among reports seen in the same poll; `since` compares observation
 * time. Limit defaults to 20, at most 100. */
export function readProgress(db: Db, query: WorkQuery): ProgressReport[] {
  const w = where(query);
  const rows = db.prepare(`SELECT report_json FROM work_progress ${w.sql} ORDER BY at DESC, json_extract(report_json, '$.at') DESC, event_id DESC LIMIT ?`).all(...w.args, clampLimit(query.limit)) as { report_json: string }[];
  return rows.flatMap((r) => { try { return [JSON.parse(r.report_json) as ProgressReport]; } catch { return []; } });
}

export function getCursor(db: Db, source: string, key: string): string | null {
  const r = db.prepare("SELECT value FROM work_cursors WHERE source=? AND key=?").get(source, key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setCursor(db: Db, source: string, key: string, value: string, at: string): void {
  db.prepare(`INSERT INTO work_cursors(source, key, value, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(source, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(source, key, value, at);
}

export function readSettings(db: Db): WorkSettings {
  const r = db.prepare("SELECT github_enabled, github_consented_at, updated_at FROM work_settings WHERE id=1").get() as
    { github_enabled: number; github_consented_at: string | null; updated_at: string } | undefined;
  return r ? { githubEnabled: r.github_enabled === 1, githubConsentedAt: r.github_consented_at, updatedAt: r.updated_at } : { githubEnabled: false, githubConsentedAt: null, updatedAt: null };
}

/** The first switch-on records consent; later changes keep that first time. */
export function writeSettings(db: Db, github: boolean, at: string): WorkSettings {
  db.prepare(`INSERT INTO work_settings(id, github_enabled, github_consented_at, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET github_enabled=excluded.github_enabled,
      github_consented_at=COALESCE(work_settings.github_consented_at, excluded.github_consented_at), updated_at=excluded.updated_at`)
    .run(github ? 1 : 0, github ? at : null, at);
  return readSettings(db);
}

const HEALTH = "health";

export function writeHealth(db: Db, h: WorkSourceHealth, at: string): void {
  setCursor(db, HEALTH, h.source, JSON.stringify({ state: h.state, lastRunAt: h.lastRunAt, detail: h.detail }), at);
}

export function readHealth(db: Db, source: WorkSource): WorkSourceHealth {
  const raw = getCursor(db, HEALTH, source);
  const empty: WorkSourceHealth = { source, state: "ok", lastRunAt: null, detail: "Not checked yet" };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as { state?: unknown; lastRunAt?: unknown; detail?: unknown };
    const state = v.state === "degraded" ? "degraded" : v.state === "off" ? "off" : "ok";
    return { source, state, lastRunAt: typeof v.lastRunAt === "string" ? v.lastRunAt : null, detail: typeof v.detail === "string" ? v.detail : null };
  } catch { return empty; }
}
