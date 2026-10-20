/**
 * The briefing: what to do next, what moved since the caller last asked, and what is waiting on you.
 * "Since you last asked" is persisted per caller in briefing_cursors, so it survives restarts of DAVE and Pew.
 * That cursor row is the only thing a briefing writes, and only when a caller is named.
 */
import type { Db } from "../db/index.ts";
import { BRIEFING_DEFAULT_HOURS, BRIEFING_MAX_DAYS, type Briefing, type BriefingCaller, type NextState } from "./next-types.ts";
import type { ProgressReport } from "../work/types.ts";

const HOUR_MS = 3_600_000;
const PROGRESS_MAX = 10;
const ALSO_READY_MAX = 3;

export type BriefingInput = {
  db: Db;
  now: Date;
  state: NextState;
  decisionsWaiting: number;
  progress: (query: { since?: string; projectId?: string; limit?: number }) => ProgressReport[];
  /** Already validated ISO timestamp. */
  since?: string;
  caller?: BriefingCaller;
};

export function storedCursor(db: Db, caller: BriefingCaller): string | null {
  const row = db.prepare("SELECT last_briefed_at FROM briefing_cursors WHERE caller=?").get(caller) as { last_briefed_at?: unknown } | undefined;
  return typeof row?.last_briefed_at === "string" && Number.isFinite(Date.parse(row.last_briefed_at)) ? row.last_briefed_at : null;
}

/** Window start: explicit, else the caller's cursor, else 24 hours ago; clamped to [now - 14 days, now]. */
export function briefingWindow(db: Db, now: Date, since?: string, caller?: BriefingCaller): { since: string; sinceSource: Briefing["sinceSource"] } {
  const cursor = since === undefined && caller ? storedCursor(db, caller) : null;
  const sinceSource: Briefing["sinceSource"] = since !== undefined ? "explicit" : cursor ? "last_asked" : "default_24h";
  const raw = since !== undefined ? Date.parse(since) : cursor ? Date.parse(cursor) : now.getTime() - BRIEFING_DEFAULT_HOURS * HOUR_MS;
  const floor = now.getTime() - BRIEFING_MAX_DAYS * 24 * HOUR_MS;
  const used = Math.min(now.getTime(), Math.max(floor, raw));
  return { since: new Date(used).toISOString(), sinceSource };
}

const count = (db: Db, sql: string, since: string): number => {
  const row = db.prepare(sql).get(since) as { n?: unknown } | undefined;
  return typeof row?.n === "number" ? row.n : 0;
};

export function buildBriefing(input: BriefingInput): Briefing {
  const { db, now, state } = input;
  const generatedAt = now.toISOString();
  const window = briefingWindow(db, now, input.since, input.caller);
  const sinceMs = Date.parse(window.since);
  // Observation time, not event time: work DAVE only saw after the last briefing still counts as new for the caller.
  const progress = input.progress({ since: window.since, limit: 50 })
    .filter((r) => Date.parse(r.observedAt) > sinceMs)
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.eventId.localeCompare(b.eventId)))
    .slice(0, PROGRESS_MAX);
  const briefing: Briefing = {
    generatedAt, since: window.since, sinceSource: window.sinceSource,
    next: state.action, alsoReady: state.queue.slice(1, 1 + ALSO_READY_MAX), progress,
    decisionsWaiting: input.decisionsWaiting,
    changedSince: {
      objectiveChanges: count(db, "SELECT COUNT(*) AS n FROM intel_changes WHERE kind='objective_changed' AND at > ?", window.since),
      workEvents: count(db, "SELECT COUNT(*) AS n FROM work_events WHERE observed_at > ?", window.since),
    },
  };
  if (input.caller) {
    db.prepare(`INSERT INTO briefing_cursors(caller, last_briefed_at, updated_at) VALUES (?,?,?)
      ON CONFLICT(caller) DO UPDATE SET last_briefed_at=excluded.last_briefed_at, updated_at=excluded.updated_at`).run(input.caller, generatedAt, generatedAt);
  }
  return briefing;
}
