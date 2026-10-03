import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import type { FathomClient, FathomFailure, FathomMeeting, FathomResult, FathomTranscriptEntry, MeetingPage } from '../src/meetings/fathom-client.ts';
import { meetingStore, type MeetingStore } from '../src/meetings/store.ts';
import { createMeetingSync, MAX_PAGES, syncWindowStart, TRANSCRIPT_RETRY_WINDOW_MS } from '../src/meetings/sync.ts';
import { meetingFixture } from './meeting-fixtures.ts';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const TRANSCRIPT: FathomTranscriptEntry[] = [
  { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:00:05', text: words(30) },
  { speaker: 'Dave Owner', email: null, timestamp: '00:00:20', text: words(30) },
];

type ListCall = { createdAfter: string; recordedBy: string; cursor: string | null };

function fakeClient(options: {
  pages?: MeetingPage[];
  listError?: FathomFailure;
  transcript?: (id: string) => FathomResult<{ entries: FathomTranscriptEntry[]; invalid: number }>;
} = {}): FathomClient & { listCalls: ListCall[]; transcriptCalls: string[] } {
  const listCalls: ListCall[] = [];
  const transcriptCalls: string[] = [];
  const pages = options.pages ?? [{ meetings: [], nextCursor: null, invalid: 0 }];
  return {
    listCalls,
    transcriptCalls,
    checkKey: async () => ({ ok: true, value: true }),
    async listMeetings(query) {
      listCalls.push(query);
      if (options.listError) return { ok: false, error: options.listError };
      const index = query.cursor ? Number(query.cursor) : 0;
      const page = pages[index];
      return page ? { ok: true, value: page } : { ok: false, error: { kind: 'bad_response' } };
    },
    async getTranscript(id) {
      transcriptCalls.push(id);
      return options.transcript?.(id) ?? { ok: true, value: { entries: TRANSCRIPT, invalid: 0 } };
    },
  };
}

let home: string;
let db: Db;
let store: MeetingStore;
let now: number;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-meeting-sync-'));
  db = openDb(home);
  store = meetingStore(db);
  now = T0;
  store.updateSettings({ fathomEmail: 'dave@studio.dev' }, new Date(now).toISOString());
  store.setConnectedAt(new Date(now).toISOString(), new Date(now).toISOString());
});
afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

const page = (meetings: FathomMeeting[], nextCursor: string | null = null): MeetingPage => ({ meetings, nextCursor, invalid: 0 });

describe('sync window', () => {
  it('starts at the history range on first sync, then three days before the last success', () => {
    expect(syncWindowStart({ lastSuccessAt: null, connectedAt: '2026-09-30T00:00:00.000Z', historyDays: 30 })).toBe('2026-08-31T00:00:00.000Z');
    expect(syncWindowStart({ lastSuccessAt: '2026-09-30T00:00:00.000Z', connectedAt: '2026-09-29T00:00:00.000Z', historyDays: 7 })).toBe('2026-09-27T00:00:00.000Z');
    // Never earlier than the history range allows.
    expect(syncWindowStart({ lastSuccessAt: '2026-09-30T00:00:00.000Z', connectedAt: '2026-09-30T00:00:00.000Z', historyDays: 1 })).toBe('2026-09-29T00:00:00.000Z');
  });
});

describe('meeting sync', () => {
  it('imports my meetings and their transcripts, then records the run', async () => {
    const client = fakeClient({ pages: [page([meetingFixture('1'), meetingFixture('2')])] });
    let changed = 0;
    const sync = createMeetingSync({ store, client, now: () => new Date(now), onChanged: () => { changed++; } });
    const result = await sync.sync('manual');
    expect(result).toMatchObject({ ran: true, outcome: 'ok', stats: { pages: 1, listed: 2, added: 2, transcripts: 2 } });
    expect(client.listCalls).toEqual([{ createdAfter: '2026-08-31T12:00:00.000Z', recordedBy: 'dave@studio.dev', cursor: null }]);
    expect(store.list().map(m => [m.recordingId, m.status])).toEqual([['2', 'imported'], ['1', 'imported']]);
    expect(store.syncState()).toMatchObject({ keyState: 'valid', lastSuccessAt: new Date(T0).toISOString(), failures: 0, cursor: null });
    expect(store.runs()[0]).toMatchObject({ trigger: 'manual', outcome: 'ok' });
    expect(changed).toBe(1);

    // The next sync lists from three days before the last success and imports nothing new.
    now += 5 * 60_000;
    const again = await sync.sync('schedule');
    expect(again).toMatchObject({ ran: true, outcome: 'ok', stats: { added: 0, transcripts: 0 } });
    expect(client.listCalls[1]?.createdAfter).toBe('2026-09-27T12:00:00.000Z');
    expect(client.transcriptCalls).toEqual(['2', '1']);
  });

  it('ignores recordings by anyone else even if Fathom returns them', async () => {
    const client = fakeClient({ pages: [page([meetingFixture('1', { recordedBy: 'someone@else.dev' })])] });
    await createMeetingSync({ store, client, now: () => new Date(now) }).sync('manual');
    expect(store.list()).toEqual([]);
  });

  it('follows cursors and resumes an interrupted backfill from the saved cursor', async () => {
    const pages = [page([meetingFixture('1')], '1'), page([meetingFixture('2')], '2'), page([meetingFixture('3')])];
    let failSecondPage = true;
    const client = fakeClient({ pages });
    const original = client.listMeetings.bind(client);
    client.listMeetings = async (query, signal) => {
      if (query.cursor === '1' && failSecondPage) { failSecondPage = false; client.listCalls.push(query); return { ok: false, error: { kind: 'network' } }; }
      return original(query, signal);
    };
    const sync = createMeetingSync({ store, client, now: () => new Date(now) });
    expect(await sync.sync('manual')).toMatchObject({ ran: true, outcome: 'error', error: 'Could not reach Fathom' });
    expect(store.syncState()).toMatchObject({ cursor: '1', cursorSince: '2026-08-31T12:00:00.000Z', cursorStartedAt: new Date(T0).toISOString(), lastSuccessAt: null, failures: 1 });
    expect(client.transcriptCalls).toEqual([]);

    // Resumed a week later: the listing's success point is still when it first began.
    now += 7 * 24 * 60 * 60_000;
    expect(await sync.sync('manual')).toMatchObject({ ran: true, outcome: 'ok', stats: { added: 2 } });
    // Resumed at the saved cursor with the original window start.
    expect(client.listCalls.at(-2)).toMatchObject({ cursor: '1', createdAfter: '2026-08-31T12:00:00.000Z' });
    expect(store.list().map(m => m.recordingId).sort()).toEqual(['1', '2', '3']);
    expect(store.syncState()).toMatchObject({ cursor: null, cursorSince: null, cursorStartedAt: null, failures: 0, lastSuccessAt: new Date(T0).toISOString() });
    // So the next listing reaches back before the interruption.
    await sync.sync('manual');
    expect(client.listCalls.at(-1)?.createdAfter).toBe(new Date(T0 - 3 * 24 * 60 * 60_000).toISOString());
  });

  it('stops after the page limit without moving the window forward', async () => {
    const pages = Array.from({ length: MAX_PAGES + 5 }, (_, i) => page([meetingFixture(String(i + 1))], String(i + 1)));
    const client = fakeClient({ pages });
    const result = await createMeetingSync({ store, client, now: () => new Date(now), transcriptsPerRun: 0 }).sync('manual');
    expect(result).toMatchObject({ ran: true, outcome: 'partial', stats: { pages: MAX_PAGES } });
    expect(store.syncState()).toMatchObject({ lastSuccessAt: null, cursor: String(MAX_PAGES) });
  });

  it('skips ignored titles without fetching, and very short transcripts after fetching', async () => {
    store.updateSettings({ ignoreWords: ['Standup'] }, new Date(now).toISOString());
    const client = fakeClient({
      pages: [page([meetingFixture('1', { title: 'Daily standup' }), meetingFixture('2')])],
      transcript: () => ({ ok: true, value: { entries: [{ speaker: 'A', email: null, timestamp: '00:00:01', text: 'hi there' }], invalid: 0 } }),
    });
    const result = await createMeetingSync({ store, client, now: () => new Date(now) }).sync('manual');
    expect(result).toMatchObject({ stats: { skipped: 2, transcripts: 0 } });
    expect(client.transcriptCalls).toEqual(['2']);
    expect(store.meeting('1')).toMatchObject({ status: 'skipped', skipReason: 'Title contains "Standup"' });
    expect(store.meeting('2')).toMatchObject({ status: 'skipped', skipReason: 'Only 2 words were spoken' });
  });

  it('retries a missing transcript and gives up after 24 hours', async () => {
    const client = fakeClient({ pages: [page([meetingFixture('1')])], transcript: () => ({ ok: false, error: { kind: 'not_found' } }) });
    const sync = createMeetingSync({ store, client, now: () => new Date(now) });
    await sync.sync('manual');
    expect(store.meeting('1')).toMatchObject({ status: 'waiting', transcriptAttempts: 1 });
    expect(store.syncState().failures).toBe(0);
    now += TRANSCRIPT_RETRY_WINDOW_MS;
    await sync.sync('manual');
    expect(store.meeting('1')).toMatchObject({ status: 'unavailable', error: 'Fathom has no transcript for this meeting yet' });
  });

  it('waits out the transcript budget instead of ending the run', async () => {
    let budgetLeft = 1;
    const slept: number[] = [];
    const client = fakeClient({
      pages: [page([meetingFixture('1'), meetingFixture('2')])],
      transcript: () => (budgetLeft-- > 0 ? { ok: true, value: { entries: TRANSCRIPT, invalid: 0 } } : (budgetLeft = 1, { ok: false, error: { kind: 'budget', retryAfterMs: 15_000 } })),
    });
    const result = await createMeetingSync({ store, client, now: () => new Date(now), sleep: async ms => { slept.push(ms); } }).sync('manual');
    expect(result).toMatchObject({ outcome: 'ok', stats: { transcripts: 2 } });
    expect(slept).toEqual([15_000]);
  });

  it('marks the key invalid and backs off on 401', async () => {
    const client = fakeClient({ listError: { kind: 'invalid_key' } });
    const sync = createMeetingSync({ store, client, now: () => new Date(now) });
    expect(await sync.sync('manual')).toMatchObject({ ran: true, outcome: 'error', error: 'Fathom rejected the API key' });
    const state = store.syncState();
    expect(state).toMatchObject({ keyState: 'invalid', failures: 1 });
    expect(Date.parse(state.backoffUntil ?? '')).toBeGreaterThan(now);
    // Scheduled runs wait for the backoff; a manual sync still tries.
    expect(await sync.sync('schedule')).toEqual({ ran: false, reason: 'backoff' });
    expect(await sync.sync('manual')).toMatchObject({ ran: true });
  });

  it('honours Retry-After when rate limited', async () => {
    const client = fakeClient({ listError: { kind: 'rate_limited', retryAfterMs: 2 * 60 * 60_000 } });
    await createMeetingSync({ store, client, now: () => new Date(now) }).sync('manual');
    expect(Date.parse(store.syncState().backoffUntil ?? '')).toBe(now + 2 * 60 * 60_000);
  });

  it('does nothing until connected with an email, and scheduled runs respect pause', async () => {
    const client = fakeClient();
    const sync = createMeetingSync({ store, client, now: () => new Date(now) });
    store.updateSettings({ paused: true }, new Date(now).toISOString());
    expect(await sync.sync('schedule')).toEqual({ ran: false, reason: 'paused' });
    store.updateSettings({ paused: false, fathomEmail: '' }, new Date(now).toISOString());
    expect(await sync.sync('manual')).toEqual({ ran: false, reason: 'no_email' });
    store.setConnectedAt(null, new Date(now).toISOString());
    expect(await sync.sync('manual')).toEqual({ ran: false, reason: 'not_connected' });
    expect(client.listCalls).toEqual([]);
  });

  it('shares one run between overlapping triggers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const client = fakeClient();
    const original = client.listMeetings.bind(client);
    client.listMeetings = async (query, signal) => { await gate; return original(query, signal); };
    const sync = createMeetingSync({ store, client, now: () => new Date(now) });
    const first = sync.sync('manual');
    expect(sync.isRunning()).toBe(true);
    expect(await sync.sync('schedule')).toEqual({ ran: false, reason: 'running' });
    const joined = sync.sync('manual');
    release();
    expect(await joined).toBe(await first);
    expect(client.listCalls).toHaveLength(1);
    expect(sync.isRunning()).toBe(false);
  });
});
