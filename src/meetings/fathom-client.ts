/**
 * Read-only Fathom API client. Fixed base URL, fixed paths, validated inputs and
 * outputs. The API key is read per call and never appears in results or errors.
 */
export const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';
export const FATHOM_TIMEOUT_MS = 15_000;
export const FATHOM_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Fathom allows 30 heavy calls a minute, sometimes only 5. DAVE stays below both. */
export const TRANSCRIPTS_PER_MINUTE = 4;

export type FathomAttendee = {
  name: string | null;
  email: string | null;
  domain: string | null;
  external: boolean;
  speakerName: string | null;
};

export type FathomMeeting = {
  recordingId: string;
  title: string;
  calendarTitle: string | null;
  url: string | null;
  shareUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  recordedBy: string;
  external: boolean;
  attendees: FathomAttendee[];
};

export type FathomTranscriptEntry = { speaker: string; email: string | null; timestamp: string; text: string };

export type FathomFailure =
  | { kind: 'no_key' }
  | { kind: 'invalid_key' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'budget'; retryAfterMs: number }
  | { kind: 'not_found' }
  | { kind: 'bad_request' }
  | { kind: 'bad_response' }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'network' }
  | { kind: 'http'; status: number };

export type FathomResult<T> = { ok: true; value: T } | { ok: false; error: FathomFailure };

export type MeetingPage = { meetings: FathomMeeting[]; nextCursor: string | null; invalid: number };
export type TranscriptResult = { entries: FathomTranscriptEntry[]; invalid: number };

/** One line per HTTP call: never the key, never a body. */
export type FathomRequestLog = {
  endpoint: 'meetings' | 'transcript';
  status: number | null;
  outcome: 'ok' | FathomFailure['kind'];
  elapsedMs: number;
  bytes: number;
};

export interface FathomClient {
  /** A light call that proves the key works without listing any meeting. */
  checkKey(signal?: AbortSignal): Promise<FathomResult<true>>;
  listMeetings(
    query: { createdAfter: string; recordedBy: string; cursor: string | null },
    signal?: AbortSignal,
  ): Promise<FathomResult<MeetingPage>>;
  getTranscript(recordingId: string, signal?: AbortSignal): Promise<FathomResult<TranscriptResult>>;
}

export interface TranscriptBudget {
  /** Returns null when a transcript fetch may start now, else how long to wait. */
  take(nowMs: number): number | null;
}

export function transcriptBudget(perMinute: number = TRANSCRIPTS_PER_MINUTE): TranscriptBudget {
  const taken: number[] = [];
  return {
    take(nowMs) {
      while (taken.length > 0 && nowMs - (taken[0] ?? 0) >= 60_000) taken.shift();
      if (taken.length >= perMinute) return 60_000 - (nowMs - (taken[0] ?? nowMs));
      taken.push(nowMs);
      return null;
    },
  };
}

export type FathomClientOptions = {
  apiKey: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  budget?: TranscriptBudget;
  timeoutMs?: number;
  maxBytes?: number;
  onRequest?: (entry: FathomRequestLog) => void;
};

const RECORDING_ID = /^\d{1,20}$/;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const TIMESTAMP = /^\d{2}:\d{2}:\d{2}$/;

export function isRecordingId(value: unknown): value is string {
  return typeof value === 'string' && RECORDING_ID.test(value);
}

export function createFathomClient(options: FathomClientOptions): FathomClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const budget = options.budget ?? transcriptBudget();
  const timeoutMs = options.timeoutMs ?? FATHOM_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? FATHOM_MAX_RESPONSE_BYTES;

  const call = async (
    endpoint: FathomRequestLog['endpoint'],
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<FathomResult<unknown>> => {
    const started = now();
    let status: number | null = null;
    let bytes = 0;
    const finish = <T>(result: FathomResult<T>): FathomResult<T> => {
      options.onRequest?.({ endpoint, status, outcome: result.ok ? 'ok' : result.error.kind, elapsedMs: Math.max(0, now() - started), bytes });
      return result;
    };
    let key: string | null;
    try { key = options.apiKey(); } catch { key = null; }
    if (!key) return finish({ ok: false, error: { kind: 'no_key' } });
    // Defense in depth: every request goes to the one fixed Fathom origin.
    if (url.origin !== new URL(FATHOM_API_BASE).origin) return finish({ ok: false, error: { kind: 'bad_request' } });
    if (signal?.aborted) return finish({ ok: false, error: { kind: 'cancelled' } });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const aborted = (): FathomResult<never> =>
      ({ ok: false, error: { kind: signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network' } });
    let response: Response;
    try {
      // A redirect could carry the key header to another host, so none are followed.
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
        redirect: 'error',
        signal: combined,
      });
    } catch {
      return finish(aborted());
    }
    status = response.status;
    if (status === 401 || status === 403) { await discard(response); return finish({ ok: false, error: { kind: 'invalid_key' } }); }
    if (status === 429) {
      await discard(response);
      return finish({ ok: false, error: { kind: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now()) } });
    }
    if (status === 404) { await discard(response); return finish({ ok: false, error: { kind: 'not_found' } }); }
    if (status < 200 || status > 299) { await discard(response); return finish({ ok: false, error: { kind: 'http', status } }); }
    let text: string | null;
    try {
      text = await readCapped(response, maxBytes, n => { bytes = n; });
    } catch {
      return finish(aborted());
    }
    if (text === null) return finish({ ok: false, error: { kind: 'too_large' } });
    try {
      return finish({ ok: true, value: JSON.parse(text) as unknown });
    } catch {
      return finish({ ok: false, error: { kind: 'bad_response' } });
    }
  };

  const listUrl = (params: [string, string][]): URL => {
    const url = new URL(`${FATHOM_API_BASE}/meetings`);
    for (const [name, value] of params) url.searchParams.append(name, value);
    return url;
  };

  return {
    async checkKey(signal) {
      const result = await call('meetings', listUrl([['created_after', new Date(now()).toISOString()]]), signal);
      if (!result.ok) return result;
      return isRecord(result.value) && Array.isArray(result.value.items)
        ? { ok: true, value: true }
        : { ok: false, error: { kind: 'bad_response' } };
    },

    async listMeetings(query, signal) {
      const createdAfter = isoDate(query.createdAfter);
      const recordedBy = parseEmail(query.recordedBy);
      if (!createdAfter || !recordedBy) return { ok: false, error: { kind: 'bad_request' } };
      if (query.cursor !== null && (query.cursor.length > 2000 || !/^[\x21-\x7e]+$/.test(query.cursor))) {
        return { ok: false, error: { kind: 'bad_request' } };
      }
      const params: [string, string][] = [['created_after', createdAfter], ['recorded_by[]', recordedBy]];
      if (query.cursor) params.push(['cursor', query.cursor]);
      const result = await call('meetings', listUrl(params), signal);
      if (!result.ok) return result;
      const body = result.value;
      if (!isRecord(body) || !Array.isArray(body.items)) return { ok: false, error: { kind: 'bad_response' } };
      const cursor = body.next_cursor;
      if (cursor !== null && cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2000)) {
        return { ok: false, error: { kind: 'bad_response' } };
      }
      const meetings: FathomMeeting[] = [];
      let invalid = 0;
      for (const raw of body.items.slice(0, 500)) {
        const meeting = parseMeeting(raw);
        if (meeting) meetings.push(meeting); else invalid++;
      }
      invalid += Math.max(0, body.items.length - 500);
      return { ok: true, value: { meetings, nextCursor: typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null, invalid } };
    },

    async getTranscript(recordingId, signal) {
      if (!isRecordingId(recordingId)) return { ok: false, error: { kind: 'bad_request' } };
      const wait = budget.take(now());
      if (wait !== null) return { ok: false, error: { kind: 'budget', retryAfterMs: wait } };
      const url = new URL(`${FATHOM_API_BASE}/recordings/${encodeURIComponent(recordingId)}/transcript`);
      const result = await call('transcript', url, signal);
      if (!result.ok) return result;
      const body = result.value;
      if (!isRecord(body) || !Array.isArray(body.transcript)) return { ok: false, error: { kind: 'bad_response' } };
      const entries: FathomTranscriptEntry[] = [];
      let invalid = 0;
      for (const raw of body.transcript) {
        const entry = parseEntry(raw);
        if (entry) entries.push(entry); else invalid++;
      }
      return { ok: true, value: { entries, invalid } };
    },
  };
}

/** Plain-language status for the UI and the run log. Never includes the key. */
export function describeFathomFailure(failure: FathomFailure): string {
  switch (failure.kind) {
    case 'no_key': return 'Add your Fathom API key';
    case 'invalid_key': return 'Fathom rejected the API key';
    case 'rate_limited': return 'Fathom asked DAVE to slow down';
    case 'budget': return 'Waiting to stay under Fathom limits';
    case 'not_found': return 'Fathom has no transcript for this meeting yet';
    case 'bad_request': return 'DAVE refused an invalid Fathom request';
    case 'bad_response': return 'Fathom returned data DAVE could not read';
    case 'too_large': return 'Fathom response was larger than 5 MB';
    case 'timeout': return 'Fathom did not answer within 15 seconds';
    case 'cancelled': return 'Cancelled';
    case 'network': return 'Could not reach Fathom';
    case 'http': return `Fathom answered with status ${failure.status}`;
  }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already closed */ }
}

async function readCapped(response: Response, max: number, onBytes: (n: number) => void): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await discard(response); return null; }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    onBytes(total);
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Seconds or an HTTP date; defaults to a minute and never waits more than an hour. */
export function retryAfterMs(header: string | null, nowMs: number): number {
  const fallback = 60_000;
  if (!header) return fallback;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return fallback;
    ms = at - nowMs;
  }
  return Math.min(3_600_000, Math.max(1000, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A lower-cased email, or null. Also validates the Fathom email in settings. */
export function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function parseDomain(value: unknown, email: string | null): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : email?.split('@')[1] ?? null;
  return raw && raw.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
}

/** Links are rendered in the UI, so only https links to Fathom's own hosts are kept. */
function fathomLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = ['fathom.video', 'fathom.ai'].some(h => host === h || host.endsWith(`.${h}`));
    return url.protocol === 'https:' && trusted && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function recordingIdOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return isRecordingId(value) && !/^0+$/.test(value) ? value : null;
}

function parseMeeting(raw: unknown): FathomMeeting | null {
  if (!isRecord(raw)) return null;
  const recordingId = recordingIdOf(raw.recording_id);
  const createdAt = isoDate(raw.created_at);
  if (!recordingId || !createdAt) return null;
  const recorder = isRecord(raw.recorded_by) ? parseEmail(raw.recorded_by.email) : null;
  const attendees = Array.isArray(raw.calendar_invitees)
    ? raw.calendar_invitees.slice(0, 100).map(parseAttendee).filter((a): a is FathomAttendee => a !== null)
    : [];
  return {
    recordingId,
    title: cleanText(raw.title, 300) ?? cleanText(raw.meeting_title, 300) ?? 'Untitled meeting',
    calendarTitle: cleanText(raw.meeting_title, 300),
    url: fathomLink(raw.url),
    shareUrl: fathomLink(raw.share_url),
    createdAt,
    startedAt: isoDate(raw.recording_start_time) ?? isoDate(raw.scheduled_start_time),
    endedAt: isoDate(raw.recording_end_time) ?? isoDate(raw.scheduled_end_time),
    recordedBy: recorder ?? '',
    external: raw.calendar_invitees_domains_type === 'one_or_more_external',
    attendees,
  };
}

function parseAttendee(raw: unknown): FathomAttendee | null {
  if (!isRecord(raw)) return null;
  const email = parseEmail(raw.email);
  const name = cleanText(raw.name, 200);
  if (!email && !name) return null;
  return {
    name,
    email,
    domain: parseDomain(raw.email_domain, email),
    external: raw.is_external === true,
    speakerName: cleanText(raw.matched_speaker_display_name, 200),
  };
}

function parseEntry(raw: unknown): FathomTranscriptEntry | null {
  if (!isRecord(raw) || !isRecord(raw.speaker)) return null;
  const text = cleanText(raw.text, 20_000);
  const timestamp = typeof raw.timestamp === 'string' && TIMESTAMP.test(raw.timestamp) ? raw.timestamp : null;
  if (!text || !timestamp) return null;
  return {
    speaker: cleanText(raw.speaker.display_name, 200) ?? 'Unknown speaker',
    email: parseEmail(raw.speaker.matched_calendar_invitee_email),
    timestamp,
    text,
  };
}
