import type { Db } from '../db/index.ts';
import { PlanningFailure, type PlanningInference } from '../providers/openai.ts';
import { datedCommitSubjects, type DatedCommit } from '../adapters/git.ts';
import type { PortfolioProject } from '../shared/types.ts';
import { checkFathomKey, fathomKeyStore, type FathomKeyStore } from './credentials.ts';
import { createFollowup, gatherEvidence, type MeetingFollowup } from './followup.ts';
import { lastWorkAt, promiseState } from './attention.ts';
import { buildAssignment, type AssignmentDraft } from './assignment.ts';
import { DISCLOSURE, DISCLOSURE_VERSION } from './disclosure.ts';
import { createExtractor, TRANSIENT_FAILURES, type AnalysisResult, type CatalogProject } from './extract.ts';
import {
  createFathomClient, describeFathomFailure, isRecordingId, parseEmail,
  type FathomClient, type FathomRequestLog,
} from './fathom-client.ts';
import { DEFAULT_INSTRUCTIONS, instructionsHash, MAX_INSTRUCTIONS_CHARS } from './prompt.ts';
import { meetingStore, type MeetingStore, type SettingsPatch } from './store.ts';
import { createMeetingSync, SYNC_INTERVAL_MS, type MeetingSync, type SyncOutcome } from './sync.ts';
import {
  HISTORY_DAYS, type HistoryDays, type InstructionsProfile, type ItemKind, type ItemStatus, type MeetingDetail, type MeetingItem,
  type MeetingRow, type MeetingsState, type ProjectMeetingsOverview, type ProjectRule,
} from './types.ts';

/** Item ids are derived hashes; anything else is rejected before touching storage. */
export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && /^mi-[0-9a-f]{24}$/.test(value);
}

/** At most this many automatic analyses per check, one at a time. */
export const MAX_AUTO_ANALYSES = 10;
/** At most this many meetings re-analyzed per bulk request. */
export const MAX_BULK_REANALYSES = 10;

/** Same shape as AgentError: routes send `statusCode` and the message, which never holds a secret. */
export class MeetingError extends Error {
  statusCode: 400 | 404 | 409 | 503;
  constructor(statusCode: 400 | 404 | 409 | 503, message: string) { super(message); this.statusCode = statusCode; }
}

export type MeetingServiceOptions = {
  keyStore?: FathomKeyStore;
  fetch?: typeof fetch;
  now?: () => Date;
  /** The owner's model connection. Without it, analysis reports that OpenAI must be connected. */
  inference?: PlanningInference;
  /** Storage-free check that the OpenAI connection is live in this session. Fails closed. */
  openAIConnected?: () => boolean;
  /** Visible projects, most relevant first. */
  projects?: () => CatalogProject[];
  /** Visible projects with their activity and tasks, for the follow-up check. */
  portfolioProjects?: () => PortfolioProject[];
  /** Dated commit subjects for the follow-up check. Defaults to the fixed read-only git command. */
  commits?: (projectPath: string) => Promise<DatedCommit[]>;
  /** Called after meetings or items change, so attention can be rebuilt. */
  onChanged?: () => void;
  /** Transcripts to try per run; tests set this low. */
  transcriptsPerRun?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (entry: FathomRequestLog) => void;
};

const MAX_ALIASES = 8;
const MAX_IGNORE_WORDS = 20;
const NO_TRANSCRIPT_STATUSES = new Set(['waiting', 'unavailable', 'forgotten']);

function cleanList(value: unknown, max: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = item.replace(/\s+/g, ' ').trim();
    if (text.length > maxLength) return null;
    if (text && !out.some(x => x.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

/** Validates a settings body. Unknown fields are rejected by the route. */
export function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (body.fathomEmail !== undefined) {
    if (body.fathomEmail === '') patch.fathomEmail = '';
    else {
      const email = parseEmail(body.fathomEmail);
      if (!email) throw new MeetingError(400, 'Enter the email you use for Fathom');
      patch.fathomEmail = email;
    }
  }
  if (body.nameAliases !== undefined) {
    const aliases = cleanList(body.nameAliases, MAX_ALIASES, 80);
    if (!aliases) throw new MeetingError(400, `Up to ${MAX_ALIASES} names of 80 characters or fewer`);
    patch.nameAliases = aliases;
  }
  if (body.ignoreWords !== undefined) {
    const words = cleanList(body.ignoreWords, MAX_IGNORE_WORDS, 60);
    if (!words) throw new MeetingError(400, `Up to ${MAX_IGNORE_WORDS} words of 60 characters or fewer`);
    patch.ignoreWords = words;
  }
  if (body.historyDays !== undefined) {
    if (!HISTORY_DAYS.includes(body.historyDays as HistoryDays)) throw new MeetingError(400, 'History must be 7, 30 or 90 days');
    patch.historyDays = body.historyDays as HistoryDays;
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') throw new MeetingError(400, 'Paused must be true or false');
    patch.paused = body.paused;
  }
  return patch;
}

export function createMeetingService(db: Db, options: MeetingServiceOptions = {}) {
  const store: MeetingStore = meetingStore(db);
  const keyStore = options.keyStore ?? fathomKeyStore();
  const now = options.now ?? (() => new Date());
  let storageError = false;
  // Whether a key is saved, learned on first use and kept current by save and disconnect,
  // so status checks do not hit the Keychain every time.
  let keySaved: boolean | null = null;
  const readKey = (): string | null => {
    try {
      const key = keyStore.read();
      storageError = false;
      keySaved = key !== null;
      return key;
    } catch {
      storageError = true;
      return null;
    }
  };
  const client: FathomClient = createFathomClient({
    apiKey: readKey,
    now: () => now().getTime(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { onRequest: options.log } : {}),
  });
  const changed = (): void => { options.onChanged?.(); };
  const sync: MeetingSync = createMeetingSync({
    store,
    client,
    now,
    onChanged: changed,
    ...(options.transcriptsPerRun !== undefined ? { transcriptsPerRun: options.transcriptsPerRun } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const extractor = createExtractor({
    db,
    store,
    now,
    infer: options.inference ?? (async () => { throw new PlanningFailure('connection_required'); }),
    projects: options.projects ?? (() => []),
  });

  const openAIConnected = (): boolean => {
    try { return options.openAIConnected?.() ?? false; } catch { return false; }
  };
  /** Automatic analysis needs the switch on with consent to the disclosure as it reads today. */
  const autoAllowed = (): boolean => {
    const s = store.settings();
    return s.autoExtract && s.consentVersion === DISCLOSURE_VERSION;
  };
  // The follow-up check shares the switch: a one-off Analyze never enables it.
  const followup: MeetingFollowup = createFollowup({
    db,
    store,
    now,
    infer: options.inference ?? (async () => { throw new PlanningFailure('connection_required'); }),
    projects: options.portfolioProjects ?? (() => []),
    commits: options.commits ?? datedCommitSubjects,
    allowed: () => autoAllowed() && openAIConnected(),
  });
  const runFollowup = async (): Promise<void> => {
    if (closing.signal.aborted || !followup.due()) return;
    const result = await followup.run(closing.signal);
    if (result.ran && result.suggested > 0) changed();
  };

  // One analysis at a time, whoever asked for it.
  const closing = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();
  let running: string | null = null;
  const queued: string[] = [];
  let autoPass: Promise<void> | null = null;
  let autoController: AbortController | null = null;
  let lastRun: Promise<SyncOutcome> | null = null;
  let stopScheduler: (() => void) | null = null;

  const runOne = async (recordingId: string, signal: AbortSignal): Promise<AnalysisResult> => {
    running = recordingId;
    try {
      return await extractor.analyze(recordingId, store.profile().instructions, signal);
    } catch {
      // Unexpected (storage) errors are recorded on the meeting instead of stopping the queue.
      const meeting = store.meeting(recordingId);
      if (meeting && meeting.status !== 'forgotten') {
        store.setStatus(recordingId, meeting.status === 'analyzed' ? 'analyzed' : 'failed', 'Analysis failed unexpectedly', now().toISOString());
      }
      return { ok: false, error: 'provider_error' };
    } finally {
      running = null;
      changed();
    }
  };

  const enqueue = (recordingId: string, signal: AbortSignal): Promise<AnalysisResult> => {
    queued.push(recordingId);
    const next = chain.then(async (): Promise<AnalysisResult> => {
      queued.splice(queued.indexOf(recordingId), 1);
      if (signal.aborted) return { ok: false, error: 'cancelled' };
      return runOne(recordingId, signal);
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const busy = (recordingId: string): boolean => running === recordingId || queued.includes(recordingId);

  /** Analyzes new meetings, oldest first. Stops when consent or the connection goes away. */
  const automaticPass = (): Promise<void> => {
    if (autoPass) return autoPass;
    if (closing.signal.aborted || !autoAllowed() || !openAIConnected()) return Promise.resolve();
    const controller = new AbortController();
    autoController = controller;
    const signal = AbortSignal.any([closing.signal, controller.signal]);
    autoPass = (async () => {
      for (const id of store.analysisQueue(MAX_AUTO_ANALYSES)) {
        if (signal.aborted || !autoAllowed() || !openAIConnected()) break;
        if (busy(id)) continue;
        const result = await enqueue(id, signal);
        // A passing failure (network, timeout) would repeat for every meeting: wait for the next check.
        if (!result.ok && TRANSIENT_FAILURES.has(result.error)) break;
      }
    })().finally(() => { autoPass = null; autoController = null; });
    return autoPass;
  };

  const requireConsent = (consentVersion: unknown): void => {
    if (autoAllowed() || consentVersion === DISCLOSURE_VERSION) return;
    throw new MeetingError(409, 'Review what DAVE sends before analyzing');
  };

  /** Only projects the owner can see; anything else is refused. */
  const knownProject = (value: unknown): string => {
    if (typeof value !== 'string' || !(options.projects?.() ?? []).some(p => p.id === value)) throw new MeetingError(400, 'Unknown project');
    return value;
  };

  const instructions = (): InstructionsProfile => {
    const profile = store.profile();
    return { ...profile, hash: instructionsHash(profile.instructions) };
  };

  const status = (): MeetingsState => {
    const state = store.syncState();
    const settings = store.settings();
    // The first status request reads the Keychain; nothing does at startup.
    const saved = keySaved ?? readKey() !== null;
    const { cursor: _cursor, cursorSince: _since, cursorStartedAt: _began, ...visible } = state;
    return {
      key: { saved, state: saved ? state.keyState : 'unknown', storageError },
      settings,
      sync: { ...visible, running: sync.isRunning(), intervalMs: SYNC_INTERVAL_MS },
      runs: store.runs(10),
      analysis: {
        disclosure: { ...DISCLOSURE, version: DISCLOSURE_VERSION },
        on: autoAllowed(),
        consentOutdated: settings.autoExtract && settings.consentVersion !== DISCLOSURE_VERSION,
        openAIConnected: openAIConnected(),
        running,
        queued: [...queued],
      },
    };
  };

  return {
    store,
    client,
    sync,
    status,
    autoAllowed,
    openAIConnected,
    instructions,

    /** Meetings without transcripts, flagged when analyzed with older instructions. */
    list(): MeetingRow[] {
      return store.list({ instructionsHash: instructions().hash });
    },

    detail(recordingId: string): MeetingDetail {
      const detail = isRecordingId(recordingId) ? store.detail(recordingId, instructions().hash) : null;
      if (!detail) throw new MeetingError(404, 'Unknown meeting');
      return detail;
    },

    /** Saves a new version of the reading instructions. Earlier analyses keep the version they used. */
    saveInstructions(input: unknown): InstructionsProfile {
      if (typeof input !== 'string') throw new MeetingError(400, 'Instructions must be text');
      // Keep line breaks and tabs; drop other control characters.
      const text = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (!text) throw new MeetingError(400, 'Write some instructions, or reset to the default');
      if (text.length > MAX_INSTRUCTIONS_CHARS) throw new MeetingError(400, `Instructions must be ${MAX_INSTRUCTIONS_CHARS} characters or fewer`);
      if (text !== store.profile().instructions) store.saveProfile('user', text, now().toISOString());
      return instructions();
    },

    resetInstructions(): InstructionsProfile {
      if (store.profile().source !== 'default') store.saveProfile('default', DEFAULT_INSTRUCTIONS, now().toISOString());
      return instructions();
    },

    /** Re-analyzes up to ten meetings analyzed with older instructions, newest first. */
    reanalyzeStale(consentVersion: unknown): MeetingsState {
      requireConsent(consentVersion);
      for (const id of store.staleAnalyses(instructions().hash, MAX_BULK_REANALYSES)) {
        if (!busy(id)) void enqueue(id, closing.signal).catch(() => undefined);
      }
      return status();
    },

    /** Saves the key, then proves it with one light call. The key is never returned. */
    async saveKey(input: unknown, signal?: AbortSignal): Promise<MeetingsState> {
      const checked = checkFathomKey(input);
      if (!checked.ok) throw new MeetingError(400, checked.error);
      try { keyStore.replace(checked.value); } catch { throw new MeetingError(503, 'The macOS Keychain is not available'); }
      storageError = false;
      keySaved = true;
      const at = now().toISOString();
      const result = await client.checkKey(signal);
      if (!result.ok) {
        store.updateSyncState({ keyState: result.error.kind === 'invalid_key' ? 'invalid' : 'unknown', lastError: describeFathomFailure(result.error) });
        if (result.error.kind === 'invalid_key') throw new MeetingError(400, 'Fathom rejected that key. Check it and try again.');
      } else {
        store.updateSyncState({ keyState: 'valid', lastError: null, failures: 0, backoffUntil: null });
        if (!store.settings().connectedAt) store.setConnectedAt(at, at);
      }
      return status();
    },

    /** Removes the key and turns analysis off. Optionally deletes every imported meeting too. */
    disconnect(input: { deleteMeetings: boolean }): MeetingsState {
      sync.cancel();
      autoController?.abort();
      try { keyStore.delete(); } catch { throw new MeetingError(503, 'The macOS Keychain is not available'); }
      keySaved = false;
      store.transaction(() => {
        if (input.deleteMeetings) store.deleteAllMeetings();
        store.setConnectedAt(null, now().toISOString());
        store.setAutoExtract(false, null, now().toISOString());
        store.updateSyncState({ keyState: 'unknown', cursor: null, cursorSince: null, cursorStartedAt: null, lastSuccessAt: null, backoffUntil: null, failures: 0, lastError: null });
      });
      changed();
      return status();
    },

    updateSettings(patch: SettingsPatch): MeetingsState {
      const before = store.settings();
      store.updateSettings(patch, now().toISOString());
      // A different Fathom account starts a fresh listing window.
      if (patch.fathomEmail !== undefined && patch.fathomEmail !== before.fathomEmail) {
        store.updateSyncState({ cursor: null, cursorSince: null, cursorStartedAt: null, lastSuccessAt: null });
      }
      if (patch.nameAliases !== undefined || patch.fathomEmail !== undefined) changed();
      return status();
    },

    /** Turns automatic analysis on (with consent to this exact disclosure) or off. */
    setAnalysis(on: boolean, consentVersion: unknown): MeetingsState {
      const at = now().toISOString();
      if (on) {
        if (consentVersion !== DISCLOSURE_VERSION) throw new MeetingError(409, 'What DAVE sends has changed. Review it again before turning analysis on.');
        store.setAutoExtract(true, DISCLOSURE_VERSION, at);
        void automaticPass();
      } else {
        store.setAutoExtract(false, null, at);
        autoController?.abort();
      }
      return status();
    },

    /**
     * Queues one meeting for analysis. Without the switch on, the request must
     * carry the disclosure version the owner just reviewed: one-off consent.
     */
    analyze(recordingId: string, consentVersion: unknown): MeetingsState {
      const meeting = isRecordingId(recordingId) ? store.meeting(recordingId) : null;
      if (!meeting || meeting.status === 'forgotten') throw new MeetingError(404, 'Unknown meeting');
      if (NO_TRANSCRIPT_STATUSES.has(meeting.status) || !meeting.transcriptHash) throw new MeetingError(409, 'This meeting has no transcript to analyze yet');
      requireConsent(consentVersion);
      if (!busy(recordingId)) void enqueue(recordingId, closing.signal).catch(() => undefined);
      return status();
    },

    /** Sends a skipped or unavailable meeting back to the transcript queue. */
    retry(recordingId: string): MeetingsState {
      const meeting = isRecordingId(recordingId) ? store.meeting(recordingId) : null;
      if (!meeting || meeting.status === 'forgotten') throw new MeetingError(404, 'Unknown meeting');
      if (!store.retryTranscript(recordingId, now().toISOString())) throw new MeetingError(409, 'Only skipped or unavailable meetings can be fetched again');
      changed();
      return status();
    },

    /**
     * Starts a sync and returns at once: a backfill can take minutes, so the UI
     * polls status instead of holding a request open.
     */
    syncNow(): MeetingsState {
      if (readKey() === null) throw new MeetingError(409, storageError ? 'The macOS Keychain is not available' : 'Add your Fathom API key first');
      if (!store.settings().connectedAt) throw new MeetingError(409, 'Save a working Fathom key first');
      if (!store.settings().fathomEmail) throw new MeetingError(409, 'Enter the email you use for Fathom first');
      lastRun = sync.sync('manual').then(
        result => { void automaticPass(); return result; },
        (): SyncOutcome => ({ ran: false, reason: 'running' }),
      );
      return status();
    },

    /** Resolves once no sync or analysis is in flight. For tests and shutdown. */
    async idle(): Promise<void> {
      for (let i = 0; i < 10; i++) {
        await lastRun;
        await autoPass;
        await chain;
        if (!sync.isRunning() && !autoPass && running === null && queued.length === 0) return;
      }
    },

    forget(recordingId: string): void {
      if (!isRecordingId(recordingId) || !store.forget(recordingId, now().toISOString())) throw new MeetingError(404, 'Unknown meeting');
      changed();
    },

    /** Projects the owner can link meetings and items to: visible ones, as in the analysis prompt. */
    projectChoices(): { id: string; name: string }[] {
      return (options.projects?.() ?? []).map(p => ({ id: p.id, name: p.name }));
    },

    /**
     * The owner picks a meeting's project, optionally remembering it for future
     * meetings with the same external company domain.
     */
    setMeetingProject(recordingId: string, body: { projectId: unknown; remember: unknown }): MeetingDetail {
      if (!isRecordingId(recordingId)) throw new MeetingError(404, 'Unknown meeting');
      const projectId = body.projectId === null ? null : knownProject(body.projectId);
      if (typeof body.remember !== 'boolean' && body.remember !== undefined) throw new MeetingError(400, 'Remember must be true or false');
      const at = now().toISOString();
      const meeting = store.meeting(recordingId);
      if (!meeting || meeting.status === 'forgotten') throw new MeetingError(404, 'Unknown meeting');
      store.transaction(() => {
        store.assignMeetingProject(recordingId, projectId, at);
        if (body.remember === true && projectId) {
          const domains = [...new Set(meeting.attendees.filter(a => a.external && a.domain).map(a => String(a.domain).toLowerCase()))];
          if (domains.length === 0) throw new MeetingError(409, 'This meeting has no external attendees to remember');
          for (const domain of domains.slice(0, 5)) store.saveRule('domain', domain, projectId, at);
        }
      });
      changed();
      return this.detail(recordingId);
    },

    rules(): ProjectRule[] { return store.rules(); },

    /**
     * The project's meeting picture: its items, the latest call's direction and
     * local work since that call. Reads only; nothing is sent anywhere.
     */
    async projectOverview(projectId: string): Promise<ProjectMeetingsOverview> {
      const project = (options.portfolioProjects?.() ?? []).find(p => p.id === projectId && !p.override.hidden);
      if (!project) throw new MeetingError(404, 'Unknown project');
      if (store.syncAgentRuns(now().toISOString()) > 0) changed();
      const last = store.lastMeetingFor(projectId);
      const sinceLastCall = last ? await gatherEvidence({ db, commits: options.commits ?? datedCommitSubjects }, project, last.at) : [];
      const items = store.items({ projectId, limit: 200 });
      const activity = { lastTechnicalActivityAt: lastWorkAt(project) };
      const promiseStates: ProjectMeetingsOverview['promiseStates'] = {};
      for (const item of items) if (item.kind === 'commitment' && item.status === 'open') promiseStates[item.id] = promiseState(item, activity, now());
      return {
        items,
        promiseStates,
        lastCall: last ? { recordingId: last.recordingId, title: last.title, at: last.at, headline: last.summary?.headline ?? null, direction: last.summary?.direction ?? [] } : null,
        sinceLastCall: sinceLastCall.slice(0, 20),
      };
    },

    deleteRule(id: unknown): ProjectRule[] {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || !store.deleteRule(id)) throw new MeetingError(404, 'Unknown rule');
      return store.rules();
    },

    /** The owner corrects an item: its wording, due date or project. Kept across re-analysis. */
    editItem(id: string, body: { text?: unknown; dueDate?: unknown; projectId?: unknown }): MeetingItem {
      const item = isItemId(id) ? store.item(id) : null;
      if (!item) throw new MeetingError(404, 'Unknown item');
      const patch: { text?: string; dueDate?: string | null; projectId?: string | null } = {};
      if (body.text !== undefined) {
        if (typeof body.text !== 'string') throw new MeetingError(400, 'Text must be text');
        const text = body.text.replace(/\s+/g, ' ').trim();
        if (!text || text.length > 600) throw new MeetingError(400, 'Text must be 1 to 600 characters');
        patch.text = text;
      }
      if (body.dueDate !== undefined) {
        if (body.dueDate !== null && (typeof body.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) || Number.isNaN(Date.parse(`${body.dueDate}T00:00:00Z`)))) {
          throw new MeetingError(400, 'Due date must be YYYY-MM-DD');
        }
        patch.dueDate = body.dueDate;
      }
      if (body.projectId !== undefined) patch.projectId = body.projectId === null ? null : knownProject(body.projectId);
      store.editItem(id, patch, now().toISOString());
      changed();
      return store.item(id) as MeetingItem;
    },

    /** Items across meetings for the Meetings page, after bringing linked agent runs up to date. */
    items(filter: { kinds: ItemKind[]; statuses: ItemStatus[] }): MeetingItem[] {
      if (store.syncAgentRuns(now().toISOString()) > 0) changed();
      return store.items({ ...filter, limit: 500 });
    },

    /** Links the Agent desk run the owner just started to the client idea it came from. */
    linkRun(id: string, runId: unknown): MeetingItem {
      if (!isItemId(id)) throw new MeetingError(404, 'Unknown item');
      if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw new MeetingError(400, 'Invalid run');
      const result = store.linkAgentRun(id, runId, now().toISOString());
      if (result === 'not_found') throw new MeetingError(404, 'Unknown item or run');
      if (result === 'not_idea') throw new MeetingError(409, 'Only a client idea can be linked to a run');
      if (result === 'busy') throw new MeetingError(409, 'This idea is already planned or closed');
      if (result === 'run_taken') throw new MeetingError(409, 'That run is linked to another idea');
      if (result === 'linked') changed();
      return store.item(id) as MeetingItem;
    },

    /** An editable Agent desk draft for a pain point's feature idea. Nothing is queued. */
    assignment(id: string): AssignmentDraft {
      const item = isItemId(id) ? store.item(id) : null;
      if (!item) throw new MeetingError(404, 'Unknown item');
      const draft = buildAssignment(item);
      if (!draft) throw new MeetingError(409, 'Only a client pain point with a feature idea and a project can become an assignment');
      return draft;
    },

    /**
     * The owner decides an item's status. "confirm" and "not_yet" answer a
     * "Looks done?" suggestion; nothing else ever closes a promise.
     */
    setItemStatus(id: string, action: unknown): MeetingItem {
      const item = isItemId(id) ? store.item(id) : null;
      if (!item) throw new MeetingError(404, 'Unknown item');
      const at = now().toISOString();
      if (action === 'confirm' || action === 'not_yet') {
        if (!store.resolveSuggestion(id, action, at)) throw new MeetingError(409, 'This item is not waiting for a decision');
      } else if (action === 'done' || action === 'dropped' || action === 'open') {
        store.setItemStatus(id, { status: action, source: 'user', note: null }, at);
      } else {
        throw new MeetingError(400, 'Choose done, dropped, open, confirm or not_yet');
      }
      changed();
      return store.item(id) ?? item;
    },

    /** Starts the 5-minute timer. Only the server entry point calls this, never tests. */
    startScheduler(): void {
      if (stopScheduler) return;
      const tick = (): void => {
        void sync.sync('schedule').catch(() => undefined)
          .then(() => automaticPass()).catch(() => undefined)
          .then(() => runFollowup()).catch(() => undefined);
      };
      const first = setTimeout(tick, 15_000);
      const timer = setInterval(tick, SYNC_INTERVAL_MS);
      first.unref();
      timer.unref();
      stopScheduler = () => { clearTimeout(first); clearInterval(timer); };
    },

    /** Stops the timer, cancels sync and analysis, and waits until nothing is writing. */
    async close(): Promise<void> {
      stopScheduler?.();
      stopScheduler = null;
      closing.abort();
      sync.cancel();
      await sync.whenIdle();
      await autoPass;
      await chain;
      await followup.whenIdle();
    },

    /** Runs the follow-up check now if it is due. For the scheduler and tests. */
    runFollowup,
  };
}

export type MeetingService = ReturnType<typeof createMeetingService>;
