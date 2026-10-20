/**
 * Clean up: bulk noise management for meeting promises, old client asks and drafted decisions.
 * The contract between the backend (src/triage/*, src/server/triage-routes.ts), the voice tools (src/voice/tools.ts)
 * and the Clean up page (src/ui/sections/CleanupView.tsx). Type-only plus constants: no Node imports, so the browser
 * bundle can import it.
 *
 * Clearing never deletes: a cleared meeting item becomes `dropped` (source `user`), which re-analysis keeps. One
 * decision clears a thing everywhere (meeting promise, Inbox row, inferred plan item, drafted decisions). Every batch
 * can be undone; undo restores only rows that are still exactly as the batch left them.
 *
 * Routes (loopback CSRF/origin guard, 64 KB JSON ceiling):
 *  POST /api/triage/preview {filter?: TriageFilter}                 -> TriagePreview
 *  POST /api/triage/apply   {keys: string[] (1..1000), action}      -> TriageResult
 *  POST /api/triage/undo    {batchId}                               -> TriageUndoResult
 *  GET  /api/triage/batches                                         -> {batches: TriageBatch[]}
 */

/** Buckets in display order. Each entry sits in exactly one bucket. */
export const TRIAGE_BUCKETS = ["overdue_promises", "stale_promises", "looks_done", "old_asks", "meeting_decisions", "ideas"] as const;
export type TriageBucket = (typeof TRIAGE_BUCKETS)[number];

export const BUCKET_LABEL: Record<TriageBucket, string> = {
  overdue_promises: "Overdue promises",
  stale_promises: "Old promises with no date",
  looks_done: "Looks done",
  old_asks: "Old client asks",
  meeting_decisions: "Drafted decisions from meetings",
  ideas: "Ideas, not promises",
};

/** One-line explanation of what puts an entry in each bucket. */
export const BUCKET_NOTE: Record<TriageBucket, string> = {
  overdue_promises: "Open meeting promises whose due date has passed.",
  stale_promises: "Open promises with no date or a later date, from a meeting at least 3 weeks ago.",
  looks_done: "Promises and asks DAVE thinks are already done or dropped.",
  old_asks: "Open client suggestions and pain points from a meeting at least 30 days ago.",
  meeting_decisions: "Decisions DAVE drafted from meetings that are still waiting on you.",
  ideas: "Open maybes and brainstormed ideas from meetings. They never became promises.",
};

/** A promise with no due date (or a future one) counts as stale once its meeting is this old. */
export const STALE_PROMISE_DAYS = 21;
/** An open client ask counts as old once its meeting is this old. */
export const OLD_ASK_DAYS = 30;
/** The preview returns at most this many entries; counts always cover everything. */
export const MAX_PREVIEW_ENTRIES = 500;
/** One apply call acts on at most this many keys. */
export const MAX_APPLY_KEYS = 1000;

/** "m:<meeting item id>" or "p:<proposal id>". */
export const TRIAGE_KEY = /^(?:m:mi-[0-9a-f]{24}|p:[A-Za-z0-9_-]{8,128})$/;
export const TRIAGE_BATCH_ID = /^tb-[0-9a-f]{24}$/;

export type TriageKind = "promise" | "ask" | "decision";
export const TRIAGE_KINDS: readonly TriageKind[] = ["promise", "ask", "decision"];

export type TriageEntry = {
  key: string;
  kind: TriageKind;
  bucket: TriageBucket;
  /** DAVE's own wording (meeting item text or decision summary). Never a verbatim quote. */
  title: string;
  projectId: string | null;
  projectName: string | null;
  dueDate: string | null;
  /** When the meeting behind it happened (ISO), when known. */
  meetingAt: string | null;
  meetingTitle: string | null;
  /** The meeting behind it (Fathom recording id), when there is one. */
  recordingId?: string | null;
  /** Plain reasons, e.g. "Due 12 Sep, 36 days ago", "From a meeting 5 weeks ago", "Never confirmed". */
  reasons: string[];
  /** You already acted on it (set its status, edited it, or confirmed or locked the plan item). Never preselected. */
  confirmed: boolean;
};

export type TriageFilter = {
  buckets?: TriageBucket[];
  projectId?: string;
  kinds?: TriageKind[];
  /** Only entries whose meeting (or, for a decision, its source) is at least this many days old. */
  olderThanDays?: number;
  /** Only entries with a due date before today. */
  overdueOnly?: boolean;
  /** Include entries you already confirmed. Off by default. */
  includeConfirmed?: boolean;
  /** Case-insensitive substring of the title, project name or meeting title. */
  text?: string;
  /** Only these keys. */
  keys?: string[];
  /** Only entries from this meeting (Fathom recording id). */
  recordingId?: string;
};

/** A recording id accepted by the `recordingId` filter. */
export const TRIAGE_RECORDING_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** clear: drop it everywhere. done: mark it done (promises and "looks done" entries only). */
export type TriageAction = "clear" | "done";
export const TRIAGE_ACTIONS: readonly TriageAction[] = ["clear", "done"];

export type TriagePreview = {
  generatedAt: string;
  /** At most MAX_PREVIEW_ENTRIES, in bucket order. */
  entries: TriageEntry[];
  /** Per-bucket counts after filtering (not capped). */
  counts: Record<TriageBucket, number>;
  total: number;
  /** Entries you confirmed that the filter hid (0 when includeConfirmed is on). */
  confirmedHidden: number;
};

export type TriageSkip = { key: string; reason: string };

export type TriageResult = {
  /** null when nothing changed (no batch is recorded). */
  batchId: string | null;
  /** Entries acted on. */
  changed: number;
  /** Entries left alone, each with a plain reason (gone, locked, not a promise…). */
  skipped: TriageSkip[];
  /** Linked records kept on purpose (for example a plan item you locked), keyed by the entry that linked them. */
  kept: TriageSkip[];
  /** One plain sentence, e.g. "Cleared 41 items." */
  summary: string;
};

export type TriageSource = "ui" | "voice";

export type TriageBatch = {
  id: string;
  createdAt: string;
  source: TriageSource;
  action: TriageAction;
  summary: string;
  count: number;
  undoneAt: string | null;
};

export type TriageUndoResult = { restored: number; skipped: number };
