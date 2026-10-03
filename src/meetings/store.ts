import type { Db } from '../db/index.ts';
import type { FathomMeeting, FathomTranscriptEntry } from './fathom-client.ts';
import { DEFAULT_INSTRUCTIONS } from './prompt.ts';
import type {
  FeatureIdea, HistoryDays, ItemKind, ItemStatus, ItemStatusSource, MeetingAttendee, MeetingCounts, MeetingDetail,
  MeetingItem, MeetingRow, MeetingSettings, MeetingStatus, MeetingSummary, MeetingSyncState, ProjectRule, ProjectSource,
  SpeakerRoleName, SyncRun,
} from './types.ts';

export const MAX_SYNC_RUNS = 50;
export const MAX_EXTRACTIONS = 3;

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const strings = (v: unknown): string[] => {
  const parsed = parseJson<unknown>(v, []);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

function attendeesOf(value: unknown): MeetingAttendee[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((a): MeetingAttendee[] => {
    if (!a || typeof a !== 'object') return [];
    const r = a as Row;
    return [{ name: str(r.name), email: str(r.email), domain: str(r.domain), external: r.external === true, speakerName: str(r.speakerName) }];
  });
}

function featureOf(value: unknown): FeatureIdea | null {
  const parsed = parseJson<unknown>(value, null);
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Row;
  const acceptance = Array.isArray(r.acceptance) ? r.acceptance.filter((x): x is string => typeof x === 'string') : [];
  return typeof r.title === 'string' && typeof r.outcome === 'string' ? { title: r.title, outcome: r.outcome, acceptance } : null;
}

function summaryOf(value: unknown): MeetingSummary | null {
  const parsed = parseJson<unknown>(value, null);
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Row;
  if (typeof r.headline !== 'string' || typeof r.overview !== 'string') return null;
  return { headline: r.headline, overview: r.overview, direction: Array.isArray(r.direction) ? r.direction.filter((x): x is string => typeof x === 'string') : [] };
}

/** Every column except the transcript. Lists must never carry transcripts. */
const MEETING_COLUMNS = `m.recording_id, m.title, m.calendar_title, m.url, m.share_url, m.created_at, m.started_at, m.ended_at,
  m.recorded_by, m.external, m.attendees_json, m.transcript_hash, m.transcript_bytes, m.transcript_attempts,
  m.transcript_next_at, m.status, m.skip_reason, m.error, m.project_id, m.project_source, m.first_seen_at, m.updated_at`;

const ITEM_SELECT = `SELECT i.*, m.title AS meeting_title, COALESCE(m.started_at, m.created_at) AS meeting_at, m.url AS meeting_url,
  p.name AS project_name
  FROM meeting_items i JOIN meetings m ON m.recording_id = i.recording_id LEFT JOIN projects p ON p.id = i.project_id`;

export type StoredMeeting = Omit<MeetingRow, 'headline' | 'analyzedAt' | 'staleInstructions' | 'counts' | 'projectName'> & {
  calendarTitle: string | null;
  shareUrl: string | null;
  recordedBy: string;
  transcriptHash: string | null;
  transcriptAttempts: number;
  transcriptNextAt: string | null;
  firstSeenAt: string;
};

export type SettingsPatch = Partial<Pick<MeetingSettings, 'fathomEmail' | 'nameAliases' | 'historyDays' | 'paused' | 'ignoreWords'>>;

export type ItemFilter = {
  kinds?: readonly ItemKind[];
  statuses?: readonly ItemStatus[];
  projectId?: string;
  recordingId?: string;
  limit?: number;
};

function mapStoredMeeting(r: Row): StoredMeeting {
  return {
    recordingId: String(r.recording_id),
    title: String(r.title),
    calendarTitle: str(r.calendar_title),
    url: str(r.url),
    shareUrl: str(r.share_url),
    createdAt: String(r.created_at),
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
    recordedBy: String(r.recorded_by ?? ''),
    external: r.external === 1,
    attendees: attendeesOf(r.attendees_json),
    transcriptHash: str(r.transcript_hash),
    transcriptBytes: r.transcript_bytes === null || r.transcript_bytes === undefined ? null : num(r.transcript_bytes),
    transcriptAttempts: num(r.transcript_attempts),
    transcriptNextAt: str(r.transcript_next_at),
    status: String(r.status) as MeetingStatus,
    skipReason: str(r.skip_reason),
    error: str(r.error),
    projectId: str(r.project_id),
    projectSource: str(r.project_source) as MeetingRow['projectSource'],
    firstSeenAt: String(r.first_seen_at),
  };
}

export function mapItem(r: Row): MeetingItem {
  return {
    id: String(r.id),
    recordingId: String(r.recording_id),
    kind: String(r.kind) as ItemKind,
    text: String(r.text),
    quote: String(r.quote),
    atSeconds: num(r.at_seconds),
    speaker: String(r.speaker),
    speakerRole: String(r.speaker_role) as SpeakerRoleName,
    projectId: str(r.project_id),
    projectName: str(r.project_name),
    projectSource: str(r.project_source) as ProjectSource | null,
    duePhrase: str(r.due_phrase),
    dueDate: str(r.due_date),
    feature: featureOf(r.feature_json),
    status: String(r.status) as ItemStatus,
    suggestedStatus: r.suggested_status === 'done' || r.suggested_status === 'dropped' ? r.suggested_status : null,
    statusSource: String(r.status_source) as ItemStatusSource,
    statusNote: str(r.status_note),
    statusChangedAt: str(r.status_changed_at),
    edited: r.edited === 1,
    agentRunId: str(r.agent_run_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    meetingTitle: String(r.meeting_title ?? ''),
    meetingAt: String(r.meeting_at ?? ''),
    meetingUrl: str(r.meeting_url),
  };
}

export function meetingStore(db: Db) {
  // Savepoints nest, so store writes can run inside refresh's save step.
  const tx = <T>(fn: () => T): T => {
    db.exec('SAVEPOINT meeting_write');
    try {
      const value = fn();
      db.exec('RELEASE meeting_write');
      return value;
    } catch (error) {
      db.exec('ROLLBACK TO meeting_write; RELEASE meeting_write');
      throw error;
    }
  };

  const emptyCounts = (): MeetingCounts => ({ commitment: 0, suggestion: 0, pain_point: 0, decision: 0 });

  const rowsWithAnalysis = (where: string, params: (string | number)[], instructionsHash: string | null): MeetingRow[] => {
    const rows = db.prepare(`SELECT ${MEETING_COLUMNS}, p.name AS project_name,
        e.summary_json, e.created_at AS analyzed_at, e.instructions_hash
      FROM meetings m
      LEFT JOIN projects p ON p.id = m.project_id
      LEFT JOIN meeting_extractions e ON e.id = (
        SELECT id FROM meeting_extractions WHERE recording_id = m.recording_id ORDER BY created_at DESC, rowid DESC LIMIT 1)
      ${where}`).all(...params) as Row[];
    const ids = rows.map(r => String(r.recording_id));
    const counts = new Map<string, MeetingCounts>();
    if (ids.length > 0) {
      const countRows = db.prepare(`SELECT recording_id, kind, COUNT(*) AS n FROM meeting_items
        WHERE recording_id IN (SELECT value FROM json_each(?)) GROUP BY recording_id, kind`).all(JSON.stringify(ids)) as Row[];
      for (const c of countRows) {
        const key = String(c.recording_id);
        const entry = counts.get(key) ?? emptyCounts();
        entry[String(c.kind) as ItemKind] = num(c.n);
        counts.set(key, entry);
      }
    }
    return rows.map(r => {
      const stored = mapStoredMeeting(r);
      const summary = summaryOf(r.summary_json);
      const analyzedHash = str(r.instructions_hash);
      return {
        recordingId: stored.recordingId,
        title: stored.title,
        createdAt: stored.createdAt,
        startedAt: stored.startedAt,
        endedAt: stored.endedAt,
        url: stored.url,
        external: stored.external,
        attendees: stored.attendees,
        status: stored.status,
        skipReason: stored.skipReason,
        error: stored.error,
        projectId: stored.projectId,
        projectName: str(r.project_name),
        projectSource: stored.projectSource,
        transcriptBytes: stored.transcriptBytes,
        headline: summary?.headline ?? null,
        analyzedAt: str(r.analyzed_at),
        staleInstructions: Boolean(analyzedHash && instructionsHash && analyzedHash !== instructionsHash),
        counts: counts.get(stored.recordingId) ?? emptyCounts(),
      };
    });
  };

  return {
    transaction: tx,

    settings(): MeetingSettings {
      const r = db.prepare('SELECT * FROM meeting_settings WHERE id = 1').get() as Row;
      return {
        fathomEmail: String(r.fathom_email ?? ''),
        nameAliases: strings(r.name_aliases_json),
        historyDays: num(r.history_days) as HistoryDays,
        paused: r.paused === 1,
        ignoreWords: strings(r.ignore_words_json),
        autoExtract: r.auto_extract === 1,
        consentVersion: str(r.consent_version),
        consentAt: str(r.consent_at),
        connectedAt: str(r.connected_at),
        updatedAt: String(r.updated_at ?? ''),
      };
    },

    updateSettings(patch: SettingsPatch, now: string): MeetingSettings {
      const current = this.settings();
      const next = { ...current, ...patch };
      db.prepare(`UPDATE meeting_settings SET fathom_email = ?, name_aliases_json = ?, history_days = ?, paused = ?,
        ignore_words_json = ?, updated_at = ? WHERE id = 1`)
        .run(next.fathomEmail, JSON.stringify(next.nameAliases), next.historyDays, next.paused ? 1 : 0, JSON.stringify(next.ignoreWords), now);
      return this.settings();
    },

    setConnectedAt(at: string | null, now: string): void {
      db.prepare('UPDATE meeting_settings SET connected_at = ?, updated_at = ? WHERE id = 1').run(at, now);
    },

    /** Turning analysis on records the exact disclosure version the user agreed to. */
    setAutoExtract(on: boolean, consentVersion: string | null, now: string): void {
      if (on && !consentVersion) throw new Error('Consent version required');
      db.prepare('UPDATE meeting_settings SET auto_extract = ?, consent_version = ?, consent_at = ?, updated_at = ? WHERE id = 1')
        .run(on ? 1 : 0, on ? consentVersion : null, on ? now : null, now);
    },

    syncState(): MeetingSyncState {
      const r = db.prepare('SELECT * FROM meeting_sync_state WHERE id = 1').get() as Row;
      return {
        keyState: String(r.key_state) as MeetingSyncState['keyState'],
        lastSuccessAt: str(r.last_success_at),
        cursor: str(r.cursor),
        cursorSince: str(r.cursor_since),
        cursorStartedAt: str(r.cursor_started_at),
        backoffUntil: str(r.backoff_until),
        failures: num(r.failures),
        lastError: str(r.last_error),
        lastRunAt: str(r.last_run_at),
        followupAt: str(r.followup_at),
      };
    },

    updateSyncState(patch: Partial<MeetingSyncState>): MeetingSyncState {
      const next = { ...this.syncState(), ...patch };
      db.prepare(`UPDATE meeting_sync_state SET key_state = ?, last_success_at = ?, cursor = ?, cursor_since = ?, cursor_started_at = ?, backoff_until = ?,
        failures = ?, last_error = ?, last_run_at = ?, followup_at = ? WHERE id = 1`)
        .run(next.keyState, next.lastSuccessAt, next.cursor, next.cursorSince, next.cursorStartedAt, next.backoffUntil, next.failures, next.lastError, next.lastRunAt, next.followupAt);
      return next;
    },

    resetSyncState(): void {
      db.prepare(`UPDATE meeting_sync_state SET key_state = 'unknown', last_success_at = NULL, cursor = NULL, cursor_since = NULL, cursor_started_at = NULL,
        backoff_until = NULL, failures = 0, last_error = NULL, last_run_at = NULL, followup_at = NULL WHERE id = 1`).run();
    },

    recordRun(run: Omit<SyncRun, 'id'>): void {
      tx(() => {
        db.prepare('INSERT INTO meeting_sync_runs(trigger, outcome, stats_json, error, started_at, finished_at) VALUES (?,?,?,?,?,?)')
          .run(run.trigger, run.outcome, JSON.stringify(run.stats), run.error, run.startedAt, run.finishedAt);
        db.prepare('DELETE FROM meeting_sync_runs WHERE id NOT IN (SELECT id FROM meeting_sync_runs ORDER BY id DESC LIMIT ?)').run(MAX_SYNC_RUNS);
      });
    },

    runs(limit: number = MAX_SYNC_RUNS): SyncRun[] {
      return (db.prepare('SELECT * FROM meeting_sync_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(r => ({
        id: num(r.id),
        trigger: String(r.trigger) as SyncRun['trigger'],
        outcome: String(r.outcome) as SyncRun['outcome'],
        stats: parseJson(r.stats_json, {}),
        error: str(r.error),
        startedAt: String(r.started_at),
        finishedAt: String(r.finished_at),
      }));
    },

    /** New meetings wait for their transcript. Known meetings only refresh metadata. Forgotten ones stay forgotten. */
    upsertMeeting(m: FathomMeeting, now: string): 'added' | 'updated' | 'ignored' {
      const existing = db.prepare('SELECT status FROM meetings WHERE recording_id = ?').get(m.recordingId) as Row | undefined;
      if (existing?.status === 'forgotten') return 'ignored';
      const attendees = JSON.stringify(m.attendees);
      if (existing) {
        db.prepare(`UPDATE meetings SET title = ?, calendar_title = ?, url = ?, share_url = ?, created_at = ?, started_at = ?,
          ended_at = ?, recorded_by = ?, external = ?, attendees_json = ?, updated_at = ? WHERE recording_id = ?`)
          .run(m.title, m.calendarTitle, m.url, m.shareUrl, m.createdAt, m.startedAt, m.endedAt, m.recordedBy, m.external ? 1 : 0, attendees, now, m.recordingId);
        return 'updated';
      }
      db.prepare(`INSERT INTO meetings(recording_id, title, calendar_title, url, share_url, created_at, started_at, ended_at, recorded_by,
          external, attendees_json, status, transcript_next_at, first_seen_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?)`)
        .run(m.recordingId, m.title, m.calendarTitle, m.url, m.shareUrl, m.createdAt, m.startedAt, m.endedAt, m.recordedBy,
          m.external ? 1 : 0, attendees, now, now, now);
      return 'added';
    },

    /** Newest first: recent meetings matter most during a backfill. */
    pendingTranscripts(now: string, limit: number): StoredMeeting[] {
      return (db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.status = 'waiting'
          AND (m.transcript_next_at IS NULL OR m.transcript_next_at <= ?) ORDER BY m.created_at DESC, m.recording_id DESC LIMIT ?`)
        .all(now, limit) as Row[]).map(mapStoredMeeting);
    },

    saveTranscript(recordingId: string, entries: readonly FathomTranscriptEntry[], meta: { hash: string; bytes: number; status: 'imported' | 'skipped'; skipReason: string | null }, now: string): void {
      db.prepare(`UPDATE meetings SET transcript_json = ?, transcript_hash = ?, transcript_bytes = ?, transcript_attempts = transcript_attempts + 1,
          transcript_next_at = NULL, status = ?, skip_reason = ?, error = NULL, updated_at = ? WHERE recording_id = ? AND status != 'forgotten'`)
        .run(JSON.stringify(entries), meta.hash, meta.bytes, meta.status, meta.skipReason, now, recordingId);
    },

    /** A transcript that is not ready yet. After the retry window it is marked unavailable. */
    transcriptMissing(recordingId: string, next: { nextAt: string | null; error: string; unavailable: boolean }, now: string): void {
      db.prepare(`UPDATE meetings SET transcript_attempts = transcript_attempts + 1, transcript_next_at = ?, error = ?,
          status = CASE WHEN ? THEN 'unavailable' ELSE status END, updated_at = ? WHERE recording_id = ? AND status = 'waiting'`)
        .run(next.unavailable ? null : next.nextAt, next.error, next.unavailable ? 1 : 0, now, recordingId);
    },

    /** Skips before any transcript is fetched (for example an ignored title word). */
    skipMeeting(recordingId: string, reason: string, now: string): void {
      db.prepare(`UPDATE meetings SET status = 'skipped', skip_reason = ?, transcript_next_at = NULL, updated_at = ?
        WHERE recording_id = ? AND status = 'waiting'`).run(reason, now, recordingId);
    },

    /**
     * Sends a skipped or unavailable meeting back to the transcript queue. The
     * retry window restarts, and skip rules are not applied again.
     */
    retryTranscript(recordingId: string, now: string): boolean {
      return tx(() => {
        // Skipped after fetching (too short): the transcript is here, so it only needs including.
        if (Number(db.prepare(`UPDATE meetings SET status = 'imported', skip_reason = NULL, error = NULL, updated_at = ?
          WHERE recording_id = ? AND status = 'skipped' AND transcript_json IS NOT NULL`).run(now, recordingId).changes) > 0) return true;
        return Number(db.prepare(`UPDATE meetings SET status = 'waiting', skip_reason = NULL, error = NULL, transcript_attempts = 0,
            transcript_next_at = NULL, first_seen_at = ?, updated_at = ?
          WHERE recording_id = ? AND status IN ('skipped','unavailable') AND transcript_json IS NULL`).run(now, now, recordingId).changes) > 0;
      });
    },

    /** Meetings ready for their first analysis, oldest first, so earlier promises exist before later meetings mention them. */
    analysisQueue(limit: number): string[] {
      return (db.prepare(`SELECT recording_id FROM meetings WHERE status = 'imported'
        ORDER BY COALESCE(started_at, created_at) ASC, recording_id ASC LIMIT ?`).all(limit) as Row[]).map(r => String(r.recording_id));
    },

    /** The owner's current reading instructions, or the default when none are saved. */
    profile(): { id: number | null; source: 'default' | 'user'; instructions: string; createdAt: string | null } {
      const r = db.prepare('SELECT id, source, instructions, created_at FROM meeting_profiles ORDER BY id DESC LIMIT 1').get() as Row | undefined;
      if (!r) return { id: null, source: 'default', instructions: DEFAULT_INSTRUCTIONS, createdAt: null };
      return { id: num(r.id), source: String(r.source) === 'user' ? 'user' : 'default', instructions: String(r.instructions), createdAt: str(r.created_at) };
    },

    /** Saves a new version; old versions stay so a change can be traced. Keeps the last 20. */
    saveProfile(source: 'default' | 'user', instructions: string, now: string): void {
      tx(() => {
        db.prepare('INSERT INTO meeting_profiles(source, instructions, created_at) VALUES (?,?,?)').run(source, instructions, now);
        db.prepare('DELETE FROM meeting_profiles WHERE id NOT IN (SELECT id FROM meeting_profiles ORDER BY id DESC LIMIT 20)').run();
      });
    },

    /** Analyzed meetings whose analysis used other instructions, newest first. */
    staleAnalyses(currentHash: string, limit: number): string[] {
      return (db.prepare(`SELECT m.recording_id FROM meetings m JOIN meeting_extractions e ON e.id = (
          SELECT id FROM meeting_extractions WHERE recording_id = m.recording_id ORDER BY created_at DESC, rowid DESC LIMIT 1)
        WHERE m.status = 'analyzed' AND e.instructions_hash != ?
        ORDER BY COALESCE(m.started_at, m.created_at) DESC LIMIT ?`).all(currentHash, limit) as Row[]).map(r => String(r.recording_id));
    },

    setStatus(recordingId: string, status: Exclude<MeetingStatus, 'forgotten' | 'waiting'>, error: string | null, now: string): void {
      db.prepare("UPDATE meetings SET status = ?, error = ?, updated_at = ? WHERE recording_id = ? AND status != 'forgotten'")
        .run(status, error, now, recordingId);
    },

    meeting(recordingId: string): StoredMeeting | null {
      const r = db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.recording_id = ?`).get(recordingId) as Row | undefined;
      return r ? mapStoredMeeting(r) : null;
    },

    transcript(recordingId: string): { entries: FathomTranscriptEntry[]; hash: string } | null {
      const r = db.prepare("SELECT transcript_json, transcript_hash FROM meetings WHERE recording_id = ? AND status != 'forgotten'").get(recordingId) as Row | undefined;
      if (!r || typeof r.transcript_json !== 'string' || typeof r.transcript_hash !== 'string') return null;
      const entries = parseJson<unknown>(r.transcript_json, null);
      if (!Array.isArray(entries)) return null;
      return {
        hash: r.transcript_hash,
        entries: entries.flatMap((e): FathomTranscriptEntry[] => {
          if (!e || typeof e !== 'object') return [];
          const x = e as Row;
          return typeof x.speaker === 'string' && typeof x.timestamp === 'string' && typeof x.text === 'string'
            ? [{ speaker: x.speaker, email: str(x.email), timestamp: x.timestamp, text: x.text }]
            : [];
        }),
      };
    },

    list(options: { limit?: number; instructionsHash?: string | null } = {}): MeetingRow[] {
      const limit = Math.min(Math.max(1, options.limit ?? 200), 500);
      return rowsWithAnalysis("WHERE m.status != 'forgotten' ORDER BY m.created_at DESC, m.recording_id DESC LIMIT ?", [limit], options.instructionsHash ?? null);
    },

    detail(recordingId: string, instructionsHash: string | null = null): MeetingDetail | null {
      const [row] = rowsWithAnalysis("WHERE m.recording_id = ? AND m.status != 'forgotten'", [recordingId], instructionsHash);
      const stored = this.meeting(recordingId);
      if (!row || !stored) return null;
      const extraction = db.prepare(`SELECT summary_json, model, stats_json FROM meeting_extractions WHERE recording_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(recordingId) as Row | undefined;
      return {
        ...row,
        calendarTitle: stored.calendarTitle,
        shareUrl: stored.shareUrl,
        summary: extraction ? summaryOf(extraction.summary_json) : null,
        model: extraction ? str(extraction.model) : null,
        analysisStats: extraction ? parseJson<Record<string, number>>(extraction.stats_json, {}) : null,
        items: this.items({ recordingId }),
      };
    },

    items(filter: ItemFilter = {}): MeetingItem[] {
      const where: string[] = ["m.status != 'forgotten'"];
      const params: (string | number)[] = [];
      if (filter.kinds?.length) { where.push('i.kind IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.kinds)); }
      if (filter.statuses?.length) { where.push('i.status IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.statuses)); }
      if (filter.projectId) { where.push('i.project_id = ?'); params.push(filter.projectId); }
      if (filter.recordingId) { where.push('i.recording_id = ?'); params.push(filter.recordingId); }
      params.push(Math.min(Math.max(1, filter.limit ?? 1000), 5000));
      return (db.prepare(`${ITEM_SELECT} WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(m.started_at, m.created_at) DESC, i.at_seconds ASC, i.id ASC LIMIT ?`).all(...params) as Row[]).map(mapItem);
    },

    item(id: string): MeetingItem | null {
      const r = db.prepare(`${ITEM_SELECT} WHERE i.id = ? AND m.status != 'forgotten'`).get(id) as Row | undefined;
      return r ? mapItem(r) : null;
    },

    setMeetingProject(recordingId: string, projectId: string | null, source: 'rule' | 'user' | 'model' | null, now: string): void {
      db.prepare("UPDATE meetings SET project_id = ?, project_source = ?, updated_at = ? WHERE recording_id = ? AND status != 'forgotten'")
        .run(projectId, projectId ? source : null, now, recordingId);
    },

    /**
     * The owner picks a meeting's project. Items that were only following the
     * meeting (or had none) move with it; items the model or owner tied to a
     * specific project keep theirs.
     */
    assignMeetingProject(recordingId: string, projectId: string | null, now: string): boolean {
      return tx(() => {
        const changed = Number(db.prepare("UPDATE meetings SET project_id = ?, project_source = ?, updated_at = ? WHERE recording_id = ? AND status != 'forgotten'")
          .run(projectId, projectId ? 'user' : null, now, recordingId).changes) > 0;
        if (changed) {
          db.prepare(`UPDATE meeting_items SET project_id = ?, project_source = ?, updated_at = ?
            WHERE recording_id = ? AND (project_source = 'meeting' OR project_source IS NULL)`)
            .run(projectId, projectId ? 'meeting' : null, now, recordingId);
        }
        return changed;
      });
    },

    /** The project a saved rule assigns: attendee email domain first, then title words. */
    matchRule(meeting: Pick<FathomMeeting, 'title' | 'attendees'> & { calendarTitle: string | null }): string | null {
      const rules = db.prepare(`SELECT r.kind, r.pattern, r.project_id FROM meeting_project_rules r JOIN projects p ON p.id = r.project_id
        ORDER BY r.kind, length(r.pattern) DESC, r.pattern`).all() as Row[];
      const domains = new Set(meeting.attendees.filter(a => a.external && a.domain).map(a => String(a.domain).toLowerCase()));
      const title = `${meeting.title} ${meeting.calendarTitle ?? ''}`.toLowerCase();
      const domain = rules.find(r => r.kind === 'domain' && domains.has(String(r.pattern)));
      if (domain) return String(domain.project_id);
      const byTitle = rules.find(r => r.kind === 'title' && title.includes(String(r.pattern).toLowerCase()));
      return byTitle ? String(byTitle.project_id) : null;
    },

    rules(): ProjectRule[] {
      return (db.prepare(`SELECT r.*, p.name AS project_name FROM meeting_project_rules r LEFT JOIN projects p ON p.id = r.project_id
        ORDER BY r.kind, r.pattern`).all() as Row[]).map(r => ({
        id: num(r.id), kind: String(r.kind) as ProjectRule['kind'], pattern: String(r.pattern), projectId: String(r.project_id),
        projectName: str(r.project_name), createdAt: String(r.created_at),
      }));
    },

    /** One rule per pattern: saving the same domain again moves it to the new project. */
    saveRule(kind: ProjectRule['kind'], pattern: string, projectId: string, now: string): void {
      db.prepare(`INSERT INTO meeting_project_rules(kind, pattern, project_id, created_at) VALUES (?,?,?,?)
        ON CONFLICT(kind, pattern) DO UPDATE SET project_id = excluded.project_id, created_at = excluded.created_at`)
        .run(kind, pattern, projectId, now);
    },

    deleteRule(id: number): boolean {
      return Number(db.prepare('DELETE FROM meeting_project_rules WHERE id = ?').run(id).changes) > 0;
    },

    /**
     * Deletes the transcript, analysis, items and any Inbox rows quoting them.
     * Keeps only the recording id so the next sync does not import it again.
     */
    forget(recordingId: string, now: string): boolean {
      return tx(() => {
        const exists = db.prepare("SELECT 1 FROM meetings WHERE recording_id = ? AND status != 'forgotten'").get(recordingId);
        if (!exists) return false;
        const itemIds = (db.prepare('SELECT id FROM meeting_items WHERE recording_id = ?').all(recordingId) as Row[]).map(r => String(r.id));
        for (const id of itemIds) db.prepare('DELETE FROM inbox_items WHERE subject_key = ?').run(JSON.stringify(['meeting', id]));
        db.prepare('DELETE FROM meeting_items WHERE recording_id = ?').run(recordingId);
        db.prepare('DELETE FROM meeting_extractions WHERE recording_id = ?').run(recordingId);
        // A "Looks done?" this meeting suggested on an earlier promise quotes it: withdraw the suggestion.
        db.prepare(`UPDATE meeting_items SET status = 'open', status_source = 'model', status_note = NULL, status_changed_at = ?, updated_at = ?,
            suggested_status = NULL, suggested_evidence_json = '[]'
          WHERE status = 'looks_done' AND status_source = 'meeting'
            AND EXISTS (SELECT 1 FROM json_each(suggested_evidence_json) WHERE value = ?)`).run(now, now, `meeting:${recordingId}`);
        db.prepare(`UPDATE meetings SET title = 'Forgotten meeting', calendar_title = NULL, url = NULL, share_url = NULL, recorded_by = '',
            attendees_json = '[]', transcript_json = NULL, transcript_hash = NULL, transcript_bytes = NULL, transcript_next_at = NULL,
            status = 'forgotten', skip_reason = NULL, error = NULL, project_id = NULL, project_source = NULL, updated_at = ?
          WHERE recording_id = ?`).run(now, recordingId);
        return true;
      });
    },

    /** The owner's corrections. Marked edited (or user-owned project), so re-analysis keeps them. */
    editItem(id: string, patch: { text?: string; dueDate?: string | null; projectId?: string | null }, now: string): boolean {
      return tx(() => {
        let changed = false;
        if (patch.text !== undefined || patch.dueDate !== undefined) {
          const current = db.prepare('SELECT text, due_date FROM meeting_items WHERE id = ?').get(id) as Row | undefined;
          if (!current) return false;
          changed = Number(db.prepare('UPDATE meeting_items SET text = ?, due_date = ?, edited = 1, updated_at = ? WHERE id = ?')
            .run(patch.text ?? String(current.text), patch.dueDate === undefined ? str(current.due_date) : patch.dueDate, now, id).changes) > 0;
        }
        if (patch.projectId !== undefined) {
          changed = Number(db.prepare("UPDATE meeting_items SET project_id = ?, project_source = 'user', updated_at = ? WHERE id = ?")
            .run(patch.projectId, now, id).changes) > 0 || changed;
        }
        return changed;
      });
    },

    /** Changes an item's status and records who changed it. Clears any pending suggestion. False for an unknown item. */
    setItemStatus(id: string, change: { status: ItemStatus; source: ItemStatusSource; note: string | null }, now: string): boolean {
      return Number(db.prepare(`UPDATE meeting_items SET status = ?, status_source = ?, status_note = ?, status_changed_at = ?, updated_at = ?,
          suggested_status = NULL, suggested_evidence_json = '[]'
        WHERE id = ?`).run(change.status, change.source, change.note, now, now, id).changes) > 0;
    },

    /**
     * Marks an open promise "Looks done?". Never closes it: the owner confirms.
     * Skipped when the owner already said "Not yet" to every piece of this evidence.
     */
    suggestStatus(id: string, suggestion: { status: 'done' | 'dropped'; source: 'meeting' | 'evidence'; evidence: string[]; note: string }, now: string): boolean {
      const r = db.prepare(`SELECT status, rejected_evidence_json FROM meeting_items WHERE id = ? AND kind = 'commitment'`).get(id) as Row | undefined;
      if (!r || r.status !== 'open' || suggestion.evidence.length === 0) return false;
      const rejected = new Set(strings(r.rejected_evidence_json));
      const fresh = suggestion.evidence.filter(e => !rejected.has(e));
      if (fresh.length === 0) return false;
      return Number(db.prepare(`UPDATE meeting_items SET status = 'looks_done', status_source = ?, status_note = ?, status_changed_at = ?, updated_at = ?,
          suggested_status = ?, suggested_evidence_json = ?
        WHERE id = ? AND status = 'open'`).run(suggestion.source, suggestion.note.slice(0, 600), now, now, suggestion.status, JSON.stringify([...new Set(suggestion.evidence)].sort()), id).changes) > 0;
    },

    /** The owner's answer to "Looks done?": confirm applies the suggestion; "Not yet" reopens and remembers the evidence. */
    resolveSuggestion(id: string, answer: 'confirm' | 'not_yet', now: string): boolean {
      const r = db.prepare(`SELECT status, suggested_status, suggested_evidence_json, rejected_evidence_json FROM meeting_items WHERE id = ?`).get(id) as Row | undefined;
      if (!r || r.status !== 'looks_done') return false;
      if (answer === 'confirm') {
        const status: ItemStatus = r.suggested_status === 'dropped' ? 'dropped' : 'done';
        return this.setItemStatus(id, { status, source: 'user', note: 'Confirmed from the evidence' }, now);
      }
      const rejected = [...new Set([...strings(r.rejected_evidence_json), ...strings(r.suggested_evidence_json)])].sort().slice(-200);
      return tx(() => {
        const changed = this.setItemStatus(id, { status: 'open', source: 'user', note: 'Not done yet' }, now);
        db.prepare('UPDATE meeting_items SET rejected_evidence_json = ? WHERE id = ?').run(JSON.stringify(rejected), id);
        return changed;
      });
    },

    /**
     * Links an Agent desk run to a client idea, which becomes "planned". Idempotent
     * for the same run; refuses a run that is linked to another idea.
     */
    linkAgentRun(itemId: string, runId: string, now: string): 'linked' | 'unchanged' | 'not_found' | 'not_idea' | 'busy' | 'run_taken' {
      return tx(() => {
        const item = db.prepare('SELECT kind, feature_json, status, agent_run_id FROM meeting_items WHERE id = ?').get(itemId) as Row | undefined;
        if (!item) return 'not_found';
        if (item.kind !== 'pain_point' || item.feature_json === null) return 'not_idea';
        if (item.agent_run_id === runId && item.status === 'planned') return 'unchanged';
        if (item.status !== 'open') return 'busy';
        const run = db.prepare('SELECT title FROM agent_runs WHERE id = ?').get(runId) as Row | undefined;
        if (!run) return 'not_found';
        if (db.prepare('SELECT 1 FROM meeting_items WHERE agent_run_id = ? AND id != ?').get(runId, itemId)) return 'run_taken';
        db.prepare(`UPDATE meeting_items SET status = 'planned', status_source = 'user', status_note = ?, agent_run_id = ?,
            suggested_status = NULL, suggested_evidence_json = '[]', status_changed_at = ?, updated_at = ? WHERE id = ?`)
          .run(`Agent run queued: ${String(run.title)}`.slice(0, 600), runId, now, now, itemId);
        return 'linked';
      });
    },

    /**
     * Reads linked Agent desk runs (never changes them). An accepted run makes its
     * idea "Delivered?" for the owner to confirm; a stopped run reopens it.
     * Returns how many items changed.
     */
    syncAgentRuns(now: string): number {
      return tx(() => {
        const accepted = db.prepare(`UPDATE meeting_items SET status = 'looks_done', status_source = 'agent', suggested_status = 'done',
            suggested_evidence_json = json_array('run:' || agent_run_id),
            status_note = substr('Agent run accepted: ' || COALESCE((SELECT title FROM agent_runs r WHERE r.id = meeting_items.agent_run_id), ''), 1, 600),
            status_changed_at = ?, updated_at = ?
          WHERE status = 'planned' AND agent_run_id IN (SELECT id FROM agent_runs WHERE status = 'accepted')`).run(now, now);
        const stopped = db.prepare(`UPDATE meeting_items SET status = 'open', status_source = 'agent', status_note = 'The agent run was stopped',
            status_changed_at = ?, updated_at = ?
          WHERE status = 'planned' AND agent_run_id IN (SELECT id FROM agent_runs WHERE status = 'stopped')`).run(now, now);
        return Number(accepted.changes) + Number(stopped.changes);
      });
    },

    /** The project's most recent meeting, with its latest summary, if any. */
    lastMeetingFor(projectId: string): { recordingId: string; title: string; at: string; summary: MeetingSummary | null } | null {
      const r = db.prepare(`SELECT m.recording_id, m.title, COALESCE(m.started_at, m.created_at) AS at,
          (SELECT summary_json FROM meeting_extractions e WHERE e.recording_id = m.recording_id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS summary_json
        FROM meetings m WHERE m.project_id = ? AND m.status != 'forgotten'
        ORDER BY at DESC, m.recording_id DESC LIMIT 1`).get(projectId) as Row | undefined;
      return r ? { recordingId: String(r.recording_id), title: String(r.title), at: String(r.at), summary: summaryOf(r.summary_json) } : null;
    },

    /** Open promises of a project, with the follow-up state kept for them, oldest meeting first. */
    followupCandidates(projectId: string): { item: MeetingItem; evidenceSeen: string | null; rejected: string[] }[] {
      return (db.prepare(`${ITEM_SELECT} WHERE i.kind = 'commitment' AND i.status = 'open' AND i.project_id = ?
          ORDER BY COALESCE(m.started_at, m.created_at) ASC, i.id ASC`).all(projectId) as Row[])
        .map(r => ({ item: mapItem(r), evidenceSeen: str(r.evidence_seen), rejected: strings(r.rejected_evidence_json) }));
    },

    /** Records which evidence a promise was checked against, so unchanged evidence is not sent again. */
    markEvidenceChecked(ids: readonly string[], signature: string, now: string): void {
      const update = db.prepare('UPDATE meeting_items SET evidence_seen = ?, evidence_checked_at = ? WHERE id = ?');
      tx(() => { for (const id of ids) update.run(signature, now, id); });
    },

    /** The meeting item behind an Inbox row, or null when the row is not a meeting row. */
    meetingItemForInbox(inboxId: string): string | null {
      const r = db.prepare('SELECT subject_key FROM inbox_items WHERE id = ?').get(inboxId) as Row | undefined;
      const subject = parseJson<unknown>(r?.subject_key, null);
      return Array.isArray(subject) && subject.length === 2 && subject[0] === 'meeting' && typeof subject[1] === 'string' ? subject[1] : null;
    },

    /** Switches off every meeting Inbox row; the reconcile step switches current ones back on in the same transaction. */
    deactivateMeetingAttention(): void {
      db.prepare(`UPDATE inbox_items SET active = 0 WHERE subject_key LIKE '["meeting",%' AND active = 1`).run();
    },

    /** Disconnect without keeping meetings: removes everything imported, including tombstones and Inbox rows. */
    deleteAllMeetings(): void {
      tx(() => {
        db.prepare(`DELETE FROM inbox_items WHERE subject_key IN (SELECT json_array('meeting', id) FROM meeting_items)`).run();
        db.prepare('DELETE FROM meeting_items').run();
        db.prepare('DELETE FROM meeting_extractions').run();
        db.prepare('DELETE FROM meetings').run();
        db.prepare('DELETE FROM meeting_sync_runs').run();
      });
    },
  };
}

export type MeetingStore = ReturnType<typeof meetingStore>;
