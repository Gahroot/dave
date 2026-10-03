import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import type { Portfolio } from '../shared/types.ts';
import { PlanningFailure, type PlanningInference } from '../providers/openai.ts';
import {
  normalizeForMatch, parseExtraction, type DropCounts, type ExtractedItem, type ParsedExtraction, type StatusUpdate, type VerifyContext,
} from './extraction-schema.ts';
import {
  buildPayload, instructionsHash, meetingDate, systemPrompt,
  type PromptAttendee, type PromptProject, type PromptPromise,
} from './prompt.ts';
import { MAX_EXTRACTIONS, type MeetingStore, type StoredMeeting } from './store.ts';
import { assignRole, MAX_PIECE_BYTES, normalizeTranscript, splitTurns, turnLine, type Identity, type Turn } from './transcript.ts';
import type { ItemKind, MeetingSummary } from './types.ts';

export const MEETING_MODEL = 'gpt-6-astra';
export const MEETING_CACHE_KEY = 'dave-meetings-v1';
export const MEETING_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 64_000;
/** A request above this is split. Leaves room under the transport's 400 KB ceiling. */
export const MAX_REQUEST_BYTES = 240_000;
const MAX_PROJECTS = 40;
const MAX_PROMISES = 30;
const MIN_PIECE_BYTES = 500;

/** A project the model may link items to. Hidden projects are never listed. */
export type CatalogProject = { id: string; name: string; path: string; focus: string | null };

/** Visible projects from the latest scan, most relevant first, each with a one-line focus. */
export function projectCatalog(portfolio: Pick<Portfolio, 'active' | 'other'> | null): CatalogProject[] {
  if (!portfolio) return [];
  return [...portfolio.active, ...portfolio.other]
    .filter(p => p.exists && !p.override.hidden)
    .map(p => {
      const focus = p.summary.recentFocus ?? p.summary.suggestedNextAction;
      return { id: p.id, name: p.name, path: p.canonicalPath, focus: focus ? focus.replace(/\s+/g, ' ').trim().slice(0, 160) || null : null };
    });
}

export type AnalysisFailure = 'no_transcript' | 'connection_required' | 'provider_restricted' | 'provider_error' | 'invalid_output' | 'timeout' | 'cancelled' | 'input_limit' | 'output_limit';

export type AnalysisResult =
  | { ok: true; extractionId: string; items: number; dropped: DropCounts; parts: number; calls: number }
  | { ok: false; error: AnalysisFailure };

export type ExtractDeps = {
  db: Db;
  store: MeetingStore;
  infer: PlanningInference;
  /** Visible projects, most relevant first. */
  projects: () => CatalogProject[];
  now: () => Date;
  /** Test overrides for the request budget and piece size, to exercise splitting. */
  maxRequestBytes?: number;
  maxPieceBytes?: number;
};

const FAILURE_TEXT: Record<AnalysisFailure, string> = {
  no_transcript: 'There is no transcript to analyze',
  connection_required: 'Connect OpenAI to analyze meetings',
  provider_restricted: 'The model refused or limited this request',
  provider_error: 'The model service failed; DAVE will try again later',
  invalid_output: 'The model answered in an unreadable shape twice',
  timeout: 'The model did not finish within five minutes',
  cancelled: 'The analysis was cancelled',
  input_limit: 'This meeting is too large to analyze',
  output_limit: 'The model answer was larger than 64 KB',
};

/** Failures worth retrying on the next check; others wait for the owner to retry. */
export const TRANSIENT_FAILURES: ReadonlySet<AnalysisFailure> = new Set(['connection_required', 'provider_error', 'timeout', 'cancelled']);

export function describeAnalysisFailure(code: AnalysisFailure): string {
  return FAILURE_TEXT[code];
}

/** Stable across re-analysis: same meeting, kind and quote give the same id. */
export function itemId(recordingId: string, kind: ItemKind, quote: string): string {
  return `mi-${createHash('sha256').update(JSON.stringify([recordingId, kind, normalizeForMatch(quote)])).digest('hex').slice(0, 24)}`;
}

function toFailure(error: unknown): AnalysisFailure {
  if (!(error instanceof PlanningFailure)) return 'provider_error';
  switch (error.code) {
    case 'connection_required': case 'provider_restricted': case 'timeout': case 'cancelled':
    case 'input_limit': case 'output_limit': case 'invalid_output':
      return error.code;
    default:
      return 'provider_error';
  }
}

/** Merges per-part summaries: first headline, joined overviews, deduplicated direction. */
export function mergeSummaries(parts: readonly MeetingSummary[]): MeetingSummary {
  if (parts.length === 1 && parts[0]) return parts[0];
  const direction: string[] = [];
  for (const part of parts) {
    for (const d of part.direction) {
      if (!direction.some(x => normalizeForMatch(x) === normalizeForMatch(d))) direction.push(d);
    }
  }
  const overview = parts.map(p => p.overview).filter(Boolean).join(' ');
  return {
    headline: parts[0]?.headline ?? 'Meeting',
    overview: overview.length > 900 ? `${overview.slice(0, 899).trimEnd()}…` : overview,
    direction: direction.slice(0, 8),
  };
}

const NO_DROPS: DropCounts = { invalid: 0, quoteNotFound: 0, wrongSpeaker: 0, unknownHandle: 0, badDate: 0, tooLong: 0, duplicate: 0 };
const addDrops = (a: DropCounts, b: DropCounts): DropCounts => ({
  invalid: a.invalid + b.invalid, quoteNotFound: a.quoteNotFound + b.quoteNotFound, wrongSpeaker: a.wrongSpeaker + b.wrongSpeaker,
  unknownHandle: a.unknownHandle + b.unknownHandle, badDate: a.badDate + b.badDate, tooLong: a.tooLong + b.tooLong, duplicate: a.duplicate + b.duplicate,
});

type CallOutcome = { ok: true; value: ParsedExtraction } | { ok: false; error: AnalysisFailure };

/**
 * Analyzes one meeting with the owner's model connection. A meeting is one
 * call unless the request exceeds the budget; then it is split into
 * overlapping pieces. Items are verified, merged and saved in one transaction,
 * keeping any status, edit or project the owner already set.
 */
export function createExtractor(deps: ExtractDeps) {
  const requestBudget = deps.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const pieceLimit = deps.maxPieceBytes ?? MAX_PIECE_BYTES;

  const callModel = async (counter: { calls: number }, system: string, user: string, verify: VerifyContext, signal: AbortSignal): Promise<CallOutcome> => {
    // One repair attempt on an unreadable answer.
    for (let attempt = 0; attempt < 2; attempt++) {
      counter.calls++;
      let raw: string;
      try {
        raw = await deps.infer({
          model: MEETING_MODEL,
          operationId: `meeting-${randomUUID()}`,
          system,
          user: attempt === 0 ? user : `${user}\n\nYour previous answer was not valid JSON in the required shape. Return only the JSON object, exactly as specified.`,
          signal,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          timeoutMs: MEETING_TIMEOUT_MS,
          cacheKey: MEETING_CACHE_KEY,
        });
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
      const parsed = parseExtraction(raw, verify);
      if (parsed.ok) return parsed;
    }
    return { ok: false, error: 'invalid_output' };
  };

  return {
    async analyze(recordingId: string, instructions: string, signal: AbortSignal): Promise<AnalysisResult> {
      const { store, db } = deps;
      const counter = { calls: 0 };
      const meeting: StoredMeeting | null = store.meeting(recordingId);
      if (!meeting) return { ok: false, error: 'no_transcript' };
      // Recorded as failed, so a meeting with nothing to read cannot hold up the automatic queue.
      const nothingToRead = (): AnalysisResult => {
        store.setStatus(recordingId, meeting.status === 'analyzed' ? 'analyzed' : 'failed', describeAnalysisFailure('no_transcript'), deps.now().toISOString());
        return { ok: false, error: 'no_transcript' };
      };
      const transcript = store.transcript(recordingId);
      if (!transcript || transcript.entries.length === 0) return nothingToRead();
      const settings = store.settings();
      const me: Identity = { email: settings.fathomEmail, aliases: settings.nameAliases };
      const turns: Turn[] = normalizeTranscript(transcript.entries, meeting.attendees, me);
      if (turns.length === 0) return nothingToRead();

      // Handles: P# for projects, C# for earlier open promises. The model never sees real ids.
      const catalog = deps.projects().slice(0, MAX_PROJECTS);
      const projectByHandle = new Map(catalog.map((p, i) => [`P${i + 1}`, p.id]));
      const handleOfProject = new Map([...projectByHandle].map(([h, id]) => [id, h]));
      const projects: PromptProject[] = catalog.map((p, i) => ({ handle: `P${i + 1}`, name: p.name, folder: path.basename(p.path), focus: p.focus }));
      const startedAt = meeting.startedAt ?? meeting.createdAt;
      const earlier = store.items({ kinds: ['commitment'], statuses: ['open', 'looks_done'] })
        .filter(i => i.recordingId !== recordingId && Date.parse(i.meetingAt) < Date.parse(startedAt))
        .slice(0, MAX_PROMISES);
      const promiseByHandle = new Map(earlier.map((c, i) => [`C${i + 1}`, c.id]));
      const promises: PromptPromise[] = earlier.map((c, i) => ({
        handle: `C${i + 1}`, project: c.projectId ? handleOfProject.get(c.projectId) ?? null : null,
        text: c.text, promisedOn: meetingDate(c.meetingAt), dueDate: c.dueDate,
      }));
      const attendees: PromptAttendee[] = meeting.attendees.map(a => ({
        name: a.name ?? a.speakerName ?? 'Attendee',
        role: assignRole({ speaker: a.speakerName ?? a.name ?? '', email: a.email }, meeting.attendees, me),
        company: a.external ? a.domain : null,
      }));
      const projectHint = meeting.projectId && meeting.projectSource !== 'model' ? handleOfProject.get(meeting.projectId) ?? null : null;
      const meta = { title: meeting.title, startedAt, endedAt: meeting.endedAt, attendees, projectHint };
      const system = systemPrompt(instructions);
      const request = (start: number, end: number, part: { index: number; count: number } | null): string =>
        buildPayload({ meeting: meta, projects, promises, turns: turns.slice(start, end), part });
      const verifyBase = {
        turns,
        projectHandles: new Set(projectByHandle.keys()),
        promiseHandles: new Set(promiseByHandle.keys()),
        meetingDate: meetingDate(startedAt),
      };

      const systemBytes = Buffer.byteLength(system);
      const wholeBytes = systemBytes + Buffer.byteLength(request(0, turns.length, null));
      const fixedBytes = systemBytes + Buffer.byteLength(request(0, 0, { index: 1, count: 2 }));
      // Measured like splitTurns measures pieces, so a retry really halves the transcript.
      const transcriptLineBytes = turns.reduce((sum, t) => sum + Buffer.byteLength(turnLine(t)) + 1, 0);
      // Rendered lines are JSON-escaped in the payload, so pieces keep a 10% margin.
      let pieceBytes = Math.max(MIN_PIECE_BYTES, Math.min(pieceLimit, Math.floor((requestBudget - fixedBytes) * 0.9)));

      let parts: ParsedExtraction[] = [];
      let failure: AnalysisFailure | null = null;
      // Round two only runs when the provider rejected a request: pieces half the size.
      for (let round = 0; round < 2; round++) {
        const pieces = round === 0 && wholeBytes <= requestBudget
          ? [{ start: 0, end: turns.length, bytes: transcriptLineBytes }]
          : splitTurns(turns, pieceBytes);
        parts = [];
        failure = null;
        for (const [i, piece] of pieces.entries()) {
          const part = pieces.length > 1 ? { index: i + 1, count: pieces.length } : null;
          const outcome = await callModel(counter, system, request(piece.start, piece.end, part), { ...verifyBase, range: { start: piece.start, end: piece.end } }, signal);
          if (!outcome.ok) { failure = outcome.error; break; }
          parts.push(outcome.value);
        }
        if (failure === null || signal.aborted || (failure !== 'provider_restricted' && failure !== 'input_limit')) break;
        const largest = Math.max(...pieces.map(p => p.bytes));
        pieceBytes = Math.max(MIN_PIECE_BYTES, Math.floor(Math.min(pieceBytes, largest) / 2));
      }

      const at = deps.now().toISOString();
      if (failure !== null) {
        if (failure !== 'cancelled') {
          // A failed re-analysis keeps the earlier results; a transient failure is retried next check.
          const status = meeting.status === 'analyzed' ? 'analyzed' : TRANSIENT_FAILURES.has(failure) ? 'imported' : 'failed';
          store.setStatus(recordingId, status, describeAnalysisFailure(failure), at);
        }
        return { ok: false, error: failure };
      }

      // Merge parts: overlapping pieces can report the same item twice.
      const items = new Map<string, ExtractedItem>();
      const updates = new Map<string, StatusUpdate>();
      let dropped = NO_DROPS;
      for (const part of parts) {
        dropped = addDrops(dropped, part.dropped);
        for (const item of part.items) {
          const id = itemId(recordingId, item.kind, item.quote);
          if (items.has(id)) dropped = { ...dropped, duplicate: dropped.duplicate + 1 };
          else items.set(id, item);
        }
        for (const update of part.statusUpdates) {
          const id = promiseByHandle.get(update.commitment);
          if (id && !updates.has(id)) updates.set(id, update);
        }
      }
      const summary = mergeSummaries(parts.map(p => p.summary));
      const extractionId = `mx-${randomUUID()}`;
      const calls = counter.calls;
      const stats = { items: items.size, parts: parts.length, calls, ...dropped };

      // The meeting's project, unless the owner or a rule set one: the most common project among its items.
      const counts = new Map<string, number>();
      for (const item of items.values()) {
        const projectId = item.project ? projectByHandle.get(item.project) : undefined;
        if (projectId) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
      }
      const topProject = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

      let saved = false;
      store.transaction(() => {
        // The meeting may have been forgotten while the model was working.
        const current = store.meeting(recordingId);
        if (!current || current.status === 'forgotten') return;
        db.prepare(`INSERT INTO meeting_extractions(id, recording_id, instructions_hash, transcript_hash, provider, model, summary_json, stats_json, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(extractionId, recordingId, instructionsHash(instructions), transcript.hash, 'openai', MEETING_MODEL, JSON.stringify(summary), JSON.stringify(stats), at);
        db.prepare(`DELETE FROM meeting_extractions WHERE recording_id = ? AND id NOT IN (
          SELECT id FROM meeting_extractions WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(recordingId, recordingId, MAX_EXTRACTIONS);

        if ((!current.projectId || current.projectSource === 'model') && topProject) store.setMeetingProject(recordingId, topProject, 'model', at);
        const meetingProject = store.meeting(recordingId)?.projectId ?? null;

        for (const [id, item] of items) {
          const modelProject = item.project ? projectByHandle.get(item.project) ?? null : null;
          const projectId = modelProject ?? meetingProject;
          const projectSource = modelProject ? 'model' : meetingProject ? 'meeting' : null;
          // Re-analysis refreshes wording, time and project, but keeps what the owner changed.
          db.prepare(`INSERT INTO meeting_items(id, recording_id, extraction_id, kind, text, quote, at_seconds, speaker, speaker_role,
              project_id, project_source, due_phrase, due_date, feature_json, status, status_source, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', 'model', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              extraction_id = excluded.extraction_id,
              quote = excluded.quote, at_seconds = excluded.at_seconds, speaker = excluded.speaker, speaker_role = excluded.speaker_role,
              text = CASE WHEN meeting_items.edited = 1 THEN meeting_items.text ELSE excluded.text END,
              due_phrase = CASE WHEN meeting_items.edited = 1 THEN meeting_items.due_phrase ELSE excluded.due_phrase END,
              due_date = CASE WHEN meeting_items.edited = 1 THEN meeting_items.due_date ELSE excluded.due_date END,
              feature_json = CASE WHEN meeting_items.edited = 1 THEN meeting_items.feature_json ELSE excluded.feature_json END,
              project_id = CASE WHEN meeting_items.project_source = 'user' THEN meeting_items.project_id ELSE excluded.project_id END,
              project_source = CASE WHEN meeting_items.project_source = 'user' THEN 'user' ELSE excluded.project_source END,
              updated_at = excluded.updated_at`)
            .run(id, recordingId, extractionId, item.kind, item.text.slice(0, 600), item.quote.slice(0, 400), item.at, item.speaker, item.role,
              projectId, projectSource, item.duePhrase, item.dueDate, item.feature ? JSON.stringify(item.feature) : null, at, at);
        }
        // Items this analysis no longer finds go away, unless the owner already acted on them.
        db.prepare(`DELETE FROM meeting_items WHERE recording_id = ? AND extraction_id IS NOT ?
            AND status = 'open' AND status_source = 'model' AND edited = 0 AND project_source IS NOT 'user' AND agent_run_id IS NULL`)
          .run(recordingId, extractionId);

        // A later meeting only suggests that an earlier promise is settled; the owner confirms.
        for (const [id, update] of updates) {
          const when = new Date(update.at * 1000).toISOString().slice(11, 19);
          const note = `${update.status === 'done' ? 'Sounds done' : 'Sounds dropped'} in "${current.title}" at ${when}. ${update.speaker}: "${update.quote}"`;
          store.suggestStatus(id, { status: update.status, source: 'meeting', evidence: [`meeting:${recordingId}`], note }, at);
        }
        store.setStatus(recordingId, 'analyzed', null, at);
        saved = true;
      });
      if (!saved) return { ok: false, error: 'cancelled' };
      return { ok: true, extractionId, items: items.size, dropped, parts: parts.length, calls };
    },
  };
}

export type MeetingExtractor = ReturnType<typeof createExtractor>;
