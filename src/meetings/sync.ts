import { describeFathomFailure as describeFailure, type FathomClient, type FathomFailure, type FathomMeeting } from './fathom-client.ts';
import type { MeetingStore, StoredMeeting } from './store.ts';
import { transcriptBytes, transcriptHash, wordCount } from './transcript.ts';
import type { SyncRun, SyncStats } from './types.ts';

export const SYNC_INTERVAL_MS = 5 * 60_000;
/** Re-list a few days back each time: Fathom may publish a meeting after later ones. */
export const OVERLAP_DAYS = 3;
export const MAX_PAGES = 20;
export const TRANSCRIPT_RETRY_WINDOW_MS = 24 * 60 * 60_000;
export const MIN_TRANSCRIPT_WORDS = 40;
const DAY_MS = 24 * 60 * 60_000;

export type SyncTrigger = SyncRun['trigger'];

export type SyncOutcome =
  | { ran: false; reason: 'running' | 'not_connected' | 'no_email' | 'paused' | 'backoff' }
  | { ran: true; outcome: SyncRun['outcome']; stats: SyncStats; error: string | null };

export type SyncDeps = {
  store: MeetingStore;
  client: FathomClient;
  now: () => Date;
  /** Called when a sync changed stored meetings, so attention can be rebuilt. */
  onChanged?: () => void;
  /** Transcripts to try per run. The client's own per-minute budget paces them. */
  transcriptsPerRun?: number;
  /** Waits out the transcript budget. Injected in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Where to start listing: the later of (last success − overlap) and (connect time − history range). */
export function syncWindowStart(input: { lastSuccessAt: string | null; connectedAt: string; historyDays: number }): string {
  const history = Date.parse(input.connectedAt) - input.historyDays * DAY_MS;
  const since = input.lastSuccessAt ? Date.parse(input.lastSuccessAt) - OVERLAP_DAYS * DAY_MS : history;
  return new Date(Math.max(history, since)).toISOString();
}

function skipReasonFor(meeting: Pick<FathomMeeting, 'title'> & { calendarTitle: string | null }, ignoreWords: readonly string[]): string | null {
  const title = `${meeting.title} ${meeting.calendarTitle ?? ''}`.toLowerCase();
  const word = ignoreWords.find(w => w.trim() && title.includes(w.trim().toLowerCase()));
  return word ? `Title contains "${word.trim()}"` : null;
}

const emptyStats = (): SyncStats => ({ pages: 0, listed: 0, added: 0, transcripts: 0, skipped: 0, unavailable: 0, invalid: 0 });

/**
 * Single-flight: overlapping triggers (timer and "Sync now") share one run.
 * The saved cursor lets an interrupted backfill resume where it stopped.
 */
export function createMeetingSync(deps: SyncDeps) {
  let running: Promise<SyncOutcome> | null = null;
  let controller: AbortController | null = null;
  // About five minutes of fetching at four a minute, so a backfill keeps moving between runs.
  const perRun = deps.transcriptsPerRun ?? 20;
  const sleep = deps.sleep ?? abortableSleep;

  const backoff = (failures: number, retryAfterMs: number | null): number =>
    Math.max(retryAfterMs ?? 0, Math.min(60 * 60_000, SYNC_INTERVAL_MS * 2 ** Math.min(failures, 4)));

  const fetchTranscript = async (meeting: StoredMeeting, stats: SyncStats, signal: AbortSignal): Promise<FathomFailure | null> => {
    const { store } = deps;
    const result = await deps.client.getTranscript(meeting.recordingId, signal);
    const at = deps.now().toISOString();
    if (!result.ok) {
      const error = result.error;
      if (error.kind === 'not_found' || error.kind === 'bad_response' || error.kind === 'too_large' || error.kind === 'http') {
        const expired = deps.now().getTime() - Date.parse(meeting.firstSeenAt) >= TRANSCRIPT_RETRY_WINDOW_MS;
        const nextAt = new Date(deps.now().getTime() + Math.min(60 * 60_000, SYNC_INTERVAL_MS * 2 ** Math.min(meeting.transcriptAttempts, 4))).toISOString();
        store.transcriptMissing(meeting.recordingId, { nextAt, error: describeFailure(error), unavailable: expired }, at);
        if (expired) stats.unavailable++;
        return null;
      }
      return error;
    }
    stats.invalid += result.value.invalid;
    const entries = result.value.entries;
    const words = wordCount(entries);
    if (entries.length === 0) {
      // Fathom may publish the transcript a little after the meeting.
      const expired = deps.now().getTime() - Date.parse(meeting.firstSeenAt) >= TRANSCRIPT_RETRY_WINDOW_MS;
      store.transcriptMissing(meeting.recordingId, { nextAt: new Date(deps.now().getTime() + SYNC_INTERVAL_MS * 2).toISOString(), error: 'The transcript is empty so far', unavailable: expired }, at);
      if (expired) stats.unavailable++;
      return null;
    }
    const short = words < MIN_TRANSCRIPT_WORDS;
    store.saveTranscript(meeting.recordingId, entries, {
      hash: transcriptHash(entries),
      bytes: transcriptBytes(entries),
      status: short ? 'skipped' : 'imported',
      skipReason: short ? `Only ${words} words were spoken` : null,
    }, at);
    if (short) stats.skipped++;
    else stats.transcripts++;
    return null;
  };

  const run = async (trigger: SyncTrigger, signal: AbortSignal): Promise<SyncOutcome> => {
    const { store, client } = deps;
    const settings = store.settings();
    const state = store.syncState();
    const started = deps.now();
    if (!settings.connectedAt) return { ran: false, reason: 'not_connected' };
    if (!settings.fathomEmail) return { ran: false, reason: 'no_email' };
    if (settings.paused && trigger === 'schedule') return { ran: false, reason: 'paused' };
    if (trigger === 'schedule' && state.backoffUntil && Date.parse(state.backoffUntil) > started.getTime()) return { ran: false, reason: 'backoff' };

    const stats = emptyStats();
    let failure: FathomFailure | null = null;
    let listed = false;
    let changed = false;

    const since = state.cursor && state.cursorSince
      ? state.cursorSince
      : syncWindowStart({ lastSuccessAt: state.lastSuccessAt, connectedAt: settings.connectedAt, historyDays: settings.historyDays });
    let cursor = state.cursor && state.cursorSince ? state.cursor : null;
    // A resumed listing only covers meetings created up to when it first began.
    const listStarted = cursor && state.cursorStartedAt ? state.cursorStartedAt : started.toISOString();

    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal.aborted) { failure = { kind: 'cancelled' }; break; }
      const result = await client.listMeetings({ createdAfter: since, recordedBy: settings.fathomEmail, cursor }, signal);
      if (!result.ok) { failure = result.error; break; }
      stats.pages++;
      stats.invalid += result.value.invalid;
      const at = deps.now().toISOString();
      store.transaction(() => {
        for (const m of result.value.meetings) {
          // The API filter is the main guard; this keeps other people's recordings out regardless.
          if (m.recordedBy !== settings.fathomEmail.toLowerCase()) continue;
          stats.listed++;
          const outcome = store.upsertMeeting(m, at);
          if (outcome === 'added') {
            stats.added++;
            changed = true;
            // Skip rules decide once, at import, so a retry can override them.
            const reason = skipReasonFor(m, settings.ignoreWords);
            if (reason) { store.skipMeeting(m.recordingId, reason, at); stats.skipped++; }
            // A remembered rule ("meetings with @acme.com → Acme") sets the project before analysis.
            const ruled = store.matchRule(m);
            if (ruled) store.setMeetingProject(m.recordingId, ruled, 'rule', at);
          }
        }
        cursor = result.value.nextCursor;
        // Save progress so an interrupted backfill resumes from this page.
        store.updateSyncState({ cursor, cursorSince: cursor ? since : null, cursorStartedAt: cursor ? listStarted : null });
      });
      if (!cursor) { listed = true; break; }
    }

    if (failure === null) {
      const pending = store.pendingTranscripts(deps.now().toISOString(), perRun);
      for (const meeting of pending) {
        let error: FathomFailure | null = null;
        for (;;) {
          if (signal.aborted) { error = { kind: 'cancelled' }; break; }
          error = await fetchTranscript(meeting, stats, signal);
          if (error?.kind !== 'budget') break;
          await sleep(Math.min(Math.max(error.retryAfterMs, 1000), 60_000), signal);
        }
        if (error) { failure = error; break; }
        changed = true;
      }
    }

    const finished = deps.now().toISOString();
    const keyFailed = failure?.kind === 'invalid_key' || failure?.kind === 'no_key';
    const outcome: SyncRun['outcome'] = failure === null ? (listed ? 'ok' : 'partial') : failure.kind === 'cancelled' ? 'partial' : 'error';
    const error = failure ? describeFailure(failure) : null;
    if (failure && failure.kind !== 'cancelled') {
      const failures = state.failures + 1;
      const retryAfter = failure.kind === 'rate_limited' ? failure.retryAfterMs : null;
      store.updateSyncState({
        keyState: keyFailed ? 'invalid' : state.keyState,
        failures,
        lastError: error,
        lastRunAt: finished,
        backoffUntil: new Date(deps.now().getTime() + backoff(failures, retryAfter)).toISOString(),
      });
    } else {
      store.updateSyncState({
        keyState: stats.pages > 0 ? 'valid' : state.keyState,
        failures: 0,
        lastError: null,
        lastRunAt: finished,
        backoffUntil: null,
        // Only a complete listing moves the window forward.
        ...(listed ? { lastSuccessAt: listStarted } : {}),
      });
    }
    store.recordRun({ trigger, outcome, stats, error, startedAt: started.toISOString(), finishedAt: finished });
    if (changed) deps.onChanged?.();
    return { ran: true, outcome, stats, error };
  };

  return {
    /** Runs one sync, or joins the one already running. */
    async sync(trigger: SyncTrigger): Promise<SyncOutcome> {
      if (running) {
        if (trigger === 'schedule') return { ran: false, reason: 'running' };
        return running;
      }
      controller = new AbortController();
      const signal = controller.signal;
      running = run(trigger, signal).finally(() => { running = null; controller = null; });
      return running;
    },
    isRunning: (): boolean => running !== null,
    /** Stops the current run at the next safe point. */
    cancel(): void { controller?.abort(); },
    /** Resolves once no run is in flight, so shutdown never writes to a closed database. */
    async whenIdle(): Promise<void> {
      if (running) await running.catch(() => undefined);
    },
  };
}

export type MeetingSync = ReturnType<typeof createMeetingSync>;
