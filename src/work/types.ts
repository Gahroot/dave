/**
 * Completion loop contract: work events the watcher observes (EZ Coder runs, local commits, opt-in merged PRs), the
 * evidence they feed into reconcile, and the progress report written after each one. Type-only plus constants: no
 * Node imports, so the browser bundle can import it.
 *
 * Work evidence can only move an intel item to `implementation_observed`, never `verified`, and the watcher never
 * starts anything. GitHub is off until the owner switches it on in Connections.
 *
 * Routes (all under /api/intel/work, loopback CSRF/origin guard):
 *  GET  /events?since&projectId&limit   -> {events: WorkEvent[]}
 *  GET  /progress?since&limit           -> {reports: ProgressReport[]}
 *  GET  /settings                       -> WorkSettingsView
 *  POST /settings {github: boolean}     -> WorkSettingsView
 *  POST /poll {}                        -> WorkPollResult
 */
import type { EvidenceState, ItemStatus } from "../intel/types.ts";

export type WorkSource = "ezcoder" | "git" | "github";
export const WORK_SOURCES: readonly WorkSource[] = ["ezcoder", "git", "github"];

export type WorkEventKind = "run_finished" | "commit" | "merge" | "pr_merged";
export const WORK_EVENT_KINDS: readonly WorkEventKind[] = ["run_finished", "commit", "merge", "pr_merged"];

export type WorkOutcome = "completed" | "failed" | "aborted" | "unverified" | "merged" | "committed";
export const WORK_OUTCOMES: readonly WorkOutcome[] = ["completed", "failed", "aborted", "unverified", "merged", "committed"];

/** How the event was tied to the plan: an explicit `DAVE-Objective:` marker, a title match, or not at all. */
export type WorkLink = "explicit" | "title" | "none";
export const WORK_LINKS: readonly WorkLink[] = ["explicit", "title", "none"];

/** Markers DAVE puts in every brief; EZ Coder transcripts, commit trailers and PR bodies carry them back. */
export const OBJECTIVE_MARKER = "DAVE-Objective";
export const ITEMS_MARKER = "DAVE-Items";
/** Objective and item ids are 16 lower-case hex characters (see `hash` in src/intel/store.ts). */
export const DAVE_ID = /^[a-f0-9]{16}$/;

/** One stored work event (table work_events). */
export type WorkEvent = {
  /** Stable: hash of source, project and ref, so the same run or commit is never stored twice. */
  id: string;
  projectId: string;
  source: WorkSource;
  /** Session id and generation, commit sha, or PR number. */
  ref: string;
  kind: WorkEventKind;
  outcome: WorkOutcome;
  /** Short, redacted: first request line, commit subject or PR title. */
  title: string;
  /** Redacted and clipped (≤1000 chars): last assistant text or PR body summary. */
  summary: string | null;
  /** When it happened (ISO). */
  at: string;
  objectiveId: string | null;
  itemIds: string[];
  link: WorkLink;
  /** When DAVE first saw it (ISO). */
  observedAt: string;
};

/** What a scanner reports before linking: the markers it found, if any. */
export type NewWorkEvent = {
  projectId: string;
  source: WorkSource;
  ref: string;
  kind: WorkEventKind;
  outcome: WorkOutcome;
  title: string;
  summary: string | null;
  at: string;
  /** Explicit `DAVE-Objective:` / `DAVE-Items:` markers; null / [] when absent. */
  marker: { objectiveId: string | null; itemIds: string[] };
};

/** Single settings row; an absent row means the defaults (GitHub off). */
export type WorkSettings = {
  githubEnabled: boolean;
  /** When the owner switched GitHub on (consent), null while it has never been on. */
  githubConsentedAt: string | null;
  updatedAt: string | null;
};

export type WorkSourceState = "ok" | "degraded" | "off";
export type WorkSourceHealth = { source: WorkSource; state: WorkSourceState; lastRunAt: string | null; detail: string | null };
/** GET/POST /api/intel/work/settings */
export type WorkSettingsView = WorkSettings & { sources: WorkSourceHealth[] };
/** POST /api/intel/work/poll */
export type WorkPollResult = { events: number; reports: number; projects: number };

/**
 * Evidence a linked work event hands to reconcile (ReconcileInput.workEvents). `itemIds` are explicit links; an
 * empty list means reconcile falls back to a title match on `text`. Failed and aborted runs are never evidence.
 */
export type WorkEvidence = {
  id: string;
  kind: "agent-task" | "git";
  label: string;
  at: string;
  text: string;
  itemIds: string[];
};

export type ItemDelta = {
  itemId: string;
  title: string;
  from: { status: ItemStatus; evidenceState: EvidenceState };
  to: { status: ItemStatus; evidenceState: EvidenceState };
};

/** Something still between the project and its finish line. `itemId` null for a delivery step. */
export type MissingPiece = {
  itemId: string | null;
  title: string;
  state: EvidenceState | "step";
  why: string;
};

export type ProgressVerdict = "moved" | "partial" | "no_match" | "failed";

/** Written once per work event after the reconcile it triggered (table work_progress). */
export type ProgressReport = {
  eventId: string;
  projectId: string;
  projectName: string;
  /** When the work happened (run finished, commit, merge). For display. */
  at: string;
  /**
   * When DAVE saw it (the poll that wrote this report). "Since you last asked" windows use this, not `at`: a merge
   * from 10:02 that DAVE only sees at 10:10 must still reach a caller who last asked at 10:05.
   */
  observedAt: string;
  /** One plain sentence, e.g. "EZ Coder finished: export to CSV now looks implemented (not verified)." */
  headline: string;
  verdict: ProgressVerdict;
  advanced: ItemDelta[];
  stillMissing: MissingPiece[];
  finishLine: { verified: number; observed: number; total: number; percentDone: number };
  nextBefore: { id: string; title: string } | null;
  nextAfter: { id: string; title: string } | null;
  source: WorkSource;
  link: WorkLink;
};
