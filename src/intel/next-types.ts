/**
 * Prepared next actions and the briefing contract. Type-only plus constants: no Node imports, so the browser bundle
 * can import it.
 *
 * DAVE prepares; the owner decides. Every op only changes DAVE's own records (proposals, steps, dates, promises,
 * skips). `hand_to_ezcoder` is descriptive only: Pew starts EZ Coder after a spoken yes, and DAVE's act route
 * refuses it with 409. DAVE never starts work.
 *
 * Routes (loopback CSRF/origin guard):
 *  GET  /api/intel/next                                  -> NextState
 *  POST /api/intel/next/:id/act {op, note?, date?}       -> NextActResult  (id /^[a-f0-9]{16}$/, op from PREPARED_OPS)
 *  GET  /api/intel/briefing?since=ISO&caller=pew|voice|ui -> Briefing
 *     With `caller`, DAVE stores when this caller was briefed (briefing_cursors) so the next call starts there.
 *     That bookkeeping row is the only thing a GET here writes; without `caller` nothing is written.
 */
import type { MarkableStep, SourceKind } from "./types.ts";
import type { ProgressReport } from "../work/types.ts";

export type PreparedOp =
  | { op: "accept_proposal"; proposalId: string }
  | { op: "reject_proposal"; proposalId: string }
  | { op: "accept_proposals"; proposalIds: string[] }
  | { op: "mark_step"; step: MarkableStep }
  | { op: "set_target_date"; date: string }
  | { op: "mark_demo" }
  | { op: "mark_promise_done"; meetingItemId: string }
  /** You confirmed the work yourself (existing verify: evidence verified, item done). */
  | { op: "mark_verified"; itemId: string }
  | { op: "copy" }
  /** Pew performs this after a spoken yes; DAVE refuses it. */
  | { op: "hand_to_ezcoder"; objectiveId: string }
  | { op: "skip"; reason?: string }
  | { op: "defer"; until: string };
export type PreparedOpName = PreparedOp["op"];
export const PREPARED_OPS: readonly PreparedOpName[] = [
  "accept_proposal", "reject_proposal", "accept_proposals", "mark_step", "set_target_date", "mark_demo",
  "mark_promise_done", "mark_verified", "copy", "hand_to_ezcoder", "skip", "defer",
];
/** Ops DAVE's act route refuses outright: they would start work. */
export const EXECUTION_OPS: readonly PreparedOpName[] = ["hand_to_ezcoder"];

export type PreparedActionKind = "build" | "verify" | "decide" | "chase" | "follow_up" | "demo" | "step" | "target_date" | "confirm_finish_line" | "retry";
export const PREPARED_ACTION_KINDS: readonly PreparedActionKind[] = ["build", "verify", "decide", "chase", "follow_up", "demo", "step", "target_date", "confirm_finish_line", "retry"];

/** How much the owner has to do: one tap, read then tap, send a drafted message, hand to EZ Coder, or do it yourself. */
export type PreparedEffort = "one_tap" | "review_then_tap" | "send_draft" | "hand_off" | "do_yourself";

export type PreparedDraft = {
  kind: "message" | "brief" | "checklist" | "agenda";
  /** Who a message goes to ("Acme", "the client"), null for briefs and checklists. */
  to: string | null;
  subject: string | null;
  text: string;
};

export type PreparedAction = {
  /** 16 hex chars, stable for the same kind, project and target. */
  id: string;
  projectId: string;
  projectName: string;
  kind: PreparedActionKind;
  title: string;
  whyNow: string;
  effort: PreparedEffort;
  primary: { label: string; op: PreparedOp };
  secondary: { label: string; op: PreparedOp }[];
  draft: PreparedDraft | null;
  doneWhen: string[];
  evidence: { label: string; at: string | null; sourceKind: SourceKind }[];
  /** What DAVE could not confirm, in plain words. */
  missing: string[];
  objectiveId: string | null;
  targetItemIds: string[];
  score: number;
  uncertain: string | null;
  /** Hash of the evidence the action rests on; a skip lapses when it changes. */
  fingerprint: string;
};

/** At most this many actions in NextState.queue. */
export const NEXT_QUEUE_MAX = 8;

export type NextState = {
  generatedAt: string;
  action: PreparedAction | null;
  /** ≤ NEXT_QUEUE_MAX, best first; queue[0] === action when present. */
  queue: PreparedAction[];
  /** Actions hidden by an active skip or defer. */
  skipped: number;
};

/** POST /api/intel/next/:id/act */
export type NextActResult = { ok: true; actionId: string; op: PreparedOpName; summary: string; next: NextState };

export type BriefingCaller = "pew" | "voice" | "ui";
export const BRIEFING_CALLERS: readonly BriefingCaller[] = ["pew", "voice", "ui"];
/** Without a stored cursor or an explicit `since`, the window is the last 24 hours. */
export const BRIEFING_DEFAULT_HOURS = 24;
/** The window never reaches further back than this. */
export const BRIEFING_MAX_DAYS = 14;

export type Briefing = {
  generatedAt: string;
  /** The window start actually used (ISO). */
  since: string;
  /** explicit = the caller passed `since`; last_asked = stored cursor for this caller; default_24h = neither. */
  sinceSource: "explicit" | "last_asked" | "default_24h";
  next: PreparedAction | null;
  /** ≤ 3 */
  alsoReady: PreparedAction[];
  /** ≤ 10, newest first. */
  progress: ProgressReport[];
  decisionsWaiting: number;
  changedSince: { objectiveChanges: number; workEvents: number };
};
