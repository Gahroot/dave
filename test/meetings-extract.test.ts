import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import { PlanningFailure, type InferenceRequest } from '../src/providers/openai.ts';
import { createExtractor, itemId, MEETING_CACHE_KEY, type CatalogProject, type ExtractDeps } from '../src/meetings/extract.ts';
import type { FathomTranscriptEntry } from '../src/meetings/fathom-client.ts';
import { instructionsHash } from '../src/meetings/prompt.ts';
import { meetingStore, type MeetingStore } from '../src/meetings/store.ts';
import { transcriptHash } from '../src/meetings/transcript.ts';
import { meetingFixture } from './meeting-fixtures.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const CATALOG: CatalogProject[] = [
  { id: 'p-acme', name: 'Acme Portal', path: '/work/acme-portal', focus: 'CSV export' },
  { id: 'p-beta', name: 'Beta App', path: '/work/beta', focus: null },
];
const ENTRIES: FathomTranscriptEntry[] = [
  { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:00:05', text: 'Morning! Did you catch the game last night?' },
  { speaker: 'Dave Owner', email: 'dave@studio.dev', timestamp: '00:00:12', text: "Ha, missed it. Anyway, let's get into the portal." },
  { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:01:02', text: 'The CSV export keeps timing out when we pick a full year of invoices.' },
  { speaker: 'Dave Owner', email: 'dave@studio.dev', timestamp: '00:01:30', text: "I'll send you the API docs by Friday so your team can pull the data directly." },
  { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:02:10', text: 'It would be great to have a filter for archived invoices.' },
  { speaker: 'Dave Owner', email: 'dave@studio.dev', timestamp: '00:02:40', text: 'Agreed, the archive filter goes into the next release.' },
];

type Payload = { transcript: string[]; part?: string; projects: { handle: string }[]; open_promises: { handle: string; text: string }[]; meeting: Record<string, unknown> };
const payloadOf = (req: InferenceRequest): Payload => JSON.parse(req.user.split('\n\nYour previous answer')[0] ?? '') as Payload;

/** Reads its own payload and quotes only lines it was given, like an honest model. */
function honestModel(extra: (p: Payload) => Record<string, unknown> = () => ({})) {
  return (req: InferenceRequest): string => {
    const p = payloadOf(req);
    const lines = p.transcript.map(line => {
      const m = /^\[T(\d+)\] \S+ (.+?) \((\w+)\): (.*)$/.exec(line);
      return m ? { turn: `T${m[1]}`, role: m[3], text: m[4] ?? '' } : null;
    }).filter((l): l is { turn: string; role: string; text: string } => l !== null);
    const firstWords = (text: string): string => text.split(' ').slice(0, 8).join(' ');
    return JSON.stringify({
      summary: { headline: p.part ? `Part ${p.part.slice(0, 1)}` : 'Export timeouts and API docs', overview: 'Client reports slow exports.', direction: ['Ship the archive filter next release', ...(p.part ? [`Direction ${p.part.slice(0, 1)}`] : [])] },
      my_commitments: lines.filter(l => l.role === 'me' && l.text.includes("I'll")).map(l => ({ text: 'Send the API docs', strength: 'firm', deliverable: 'API docs', owed_to: 'client', due_phrase: 'by Friday', due_date: '2026-10-02', project: 'P1', quote: firstWords(l.text), turn: l.turn })),
      client_suggestions: lines.filter(l => l.role === 'client' && l.text.includes('filter')).map(l => ({ text: 'Filter archived invoices', strength: 'idea', project: 'P1', quote: firstWords(l.text), turn: l.turn })),
      client_pain_points: lines.filter(l => l.role === 'client' && l.text.includes('timing out')).map(l => ({ text: 'Full-year export times out', project: 'P1', quote: firstWords(l.text), turn: l.turn, feature_idea: { title: 'Background export', outcome: 'Full-year exports finish', acceptance: ['A full-year export completes', 'The client gets a download link'] } })),
      decisions: lines.filter(l => l.text.startsWith('Agreed')).map(l => ({ text: 'Archive filter ships next release', strength: 'firm', project: null, quote: firstWords(l.text), turn: l.turn })),
      status_updates: [],
      ...extra(p),
    });
  };
}

let home: string;
let db: Db;
let store: MeetingStore;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-meeting-extract-'));
  db = openDb(home);
  for (const p of CATALOG) db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(p.id, p.path, p.name, '2026-01-01', '2026-01-01');
  store = meetingStore(db);
  store.updateSettings({ fathomEmail: 'dave@studio.dev' }, NOW.toISOString());
});
afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

function importMeeting(id: string, entries: FathomTranscriptEntry[] = ENTRIES, startedAt = '2026-09-28T16:00:00.000Z'): void {
  store.upsertMeeting(meetingFixture(id, { startedAt, createdAt: startedAt }), NOW.toISOString());
  store.saveTranscript(id, entries, { hash: transcriptHash(entries), bytes: 1000, status: 'imported', skipReason: null }, NOW.toISOString());
}

function extractor(infer: (req: InferenceRequest) => string | Promise<string>, over: Partial<ExtractDeps> = {}) {
  const requests: InferenceRequest[] = [];
  const x = createExtractor({
    db, store, now: () => NOW, projects: () => CATALOG,
    infer: async req => { requests.push(req); return infer(req); },
    ...over,
  });
  return { x, requests };
}
const signal = (): AbortSignal => new AbortController().signal;

describe('meeting analysis', () => {
  it('analyzes a meeting in one call and saves verified items with stable ids', async () => {
    importMeeting('100');
    const { x, requests } = extractor(honestModel());
    const result = await x.analyze('100', 'Track design feedback too.', signal());
    expect(result).toMatchObject({ ok: true, items: 4, parts: 1, calls: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'gpt-6-astra', cacheKey: MEETING_CACHE_KEY, timeoutMs: 300_000, maxOutputBytes: 64_000 });
    expect(requests[0]!.system).toContain('Track design feedback too.');
    // Names and roles only: no emails leave the machine.
    expect(requests[0]!.user).not.toContain('@');
    expect(payloadOf(requests[0]!).projects.map(p => p.handle)).toEqual(['P1', 'P2']);

    const detail = store.detail('100', instructionsHash('Track design feedback too.'));
    expect(detail).toMatchObject({ status: 'analyzed', projectId: 'p-acme', projectSource: 'model', staleInstructions: false, model: 'gpt-6-astra',
      summary: { headline: 'Export timeouts and API docs' }, counts: { commitment: 1, suggestion: 0, pain_point: 1, decision: 1 } });
    // "It would be great to have a filter" is an idea: stored, but not counted as an ask.
    expect(detail?.items.find(i => i.kind === 'suggestion')).toMatchObject({ strength: 'tentative', strengthSource: 'model' });
    const promise = detail?.items.find(i => i.kind === 'commitment');
    expect(promise?.quote).toBe("I'll send you the API docs by Friday");
    expect(promise).toMatchObject({ id: itemId('100', 'commitment', "i'll SEND you the api docs by friday"), speaker: 'Dave Owner', speakerRole: 'me', atSeconds: 90,
      projectId: 'p-acme', projectSource: 'model', dueDate: '2026-10-02', status: 'open', strength: 'firm', strengthSource: 'model', deliverable: 'API docs' });
    const decision = detail?.items.find(i => i.kind === 'decision');
    // No project from the model: the item inherits the meeting's project.
    expect(decision).toMatchObject({ projectId: 'p-acme', projectSource: 'meeting' });
    expect(detail?.items.find(i => i.kind === 'pain_point')?.feature).toMatchObject({ title: 'Background export' });
  });

  it('re-analysis keeps what the owner changed and removes items no longer found', async () => {
    importMeeting('100');
    await extractor(honestModel()).x.analyze('100', '', signal());
    const promise = store.items({ kinds: ['commitment'] })[0]!;
    const suggestion = store.items({ kinds: ['suggestion'] })[0]!;
    db.prepare("UPDATE meeting_items SET status = 'done', status_source = 'user' WHERE id = ?").run(promise.id);
    db.prepare("UPDATE meeting_items SET text = 'My wording', edited = 1, project_id = 'p-beta', project_source = 'user' WHERE id = ?").run(suggestion.id);

    // The second answer drops the decision and the pain point and rewords everything else.
    const second = extractor(honestModel(() => ({ decisions: [], client_pain_points: [] })));
    expect(await second.x.analyze('100', '', signal())).toMatchObject({ ok: true, items: 2 });
    expect(store.item(promise.id)).toMatchObject({ status: 'done', statusSource: 'user' });
    expect(store.item(suggestion.id)).toMatchObject({ text: 'My wording', edited: true, projectId: 'p-beta', projectSource: 'user' });
    expect(store.items({ recordingId: '100' }).map(i => i.kind).sort()).toEqual(['commitment', 'suggestion']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_extractions').get()).toMatchObject({ n: 2 });
    // Only the last three analyses are kept.
    for (let i = 0; i < 3; i++) await second.x.analyze('100', '', signal());
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_extractions').get()).toMatchObject({ n: 3 });
  });

  it('keeps the strength you set through re-analysis, and keeps an idea you marked even when the model drops it', async () => {
    importMeeting('100');
    await extractor(honestModel()).x.analyze('100', '', signal());
    const promise = store.items({ kinds: ['commitment'] })[0]!;
    const idea = store.items({ kinds: ['suggestion'] })[0]!;
    expect(promise).toMatchObject({ strength: 'firm', strengthSource: 'model' });
    expect(idea).toMatchObject({ strength: 'tentative', strengthSource: 'model' });
    expect(store.setStrength(promise.id, 'tentative', NOW.toISOString())).toBe(true);
    expect(store.setStrength(idea.id, 'firm', NOW.toISOString())).toBe(true);
    expect(store.setStrength('mi-unknown', 'firm', NOW.toISOString())).toBe(false);

    // The model still reads the promise as firm, and no longer reports the idea at all.
    await extractor(honestModel(() => ({ client_suggestions: [] }))).x.analyze('100', '', signal());
    expect(store.item(promise.id)).toMatchObject({ strength: 'tentative', strengthSource: 'user' });
    expect(store.item(idea.id)).toMatchObject({ strength: 'firm', strengthSource: 'user' });
    expect(store.detail('100')?.counts).toMatchObject({ commitment: 0, suggestion: 1 });
  });

  it('repairs one unreadable answer, and fails after two', async () => {
    importMeeting('100');
    let n = 0;
    const once = extractor(req => (n++ === 0 ? 'Sure! Here is the JSON:' : honestModel()(req)));
    expect(await once.x.analyze('100', '', signal())).toMatchObject({ ok: true, calls: 2 });
    expect(once.requests[1]!.user).toContain('Your previous answer was not valid JSON');

    importMeeting('200');
    const never = extractor(() => '{"summary": 1}');
    expect(await never.x.analyze('200', '', signal())).toEqual({ ok: false, error: 'invalid_output' });
    expect(never.requests).toHaveLength(2);
    expect(store.meeting('200')).toMatchObject({ status: 'failed', error: 'The model answered in an unreadable shape twice' });
  });

  it('splits an oversized meeting into overlapping parts and merges the result', async () => {
    const filler = Array.from({ length: 40 }, (_, i): FathomTranscriptEntry => ({
      speaker: i % 2 ? 'Dave Owner' : 'Jane Client', email: i % 2 ? 'dave@studio.dev' : 'jane@acme.com',
      timestamp: `00:${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
      text: i === 21 ? "I'll send you the API docs by Friday so your team can pull the data." : `Discussing the reporting screen layout and the column widths, round ${i}.`,
    }));
    importMeeting('300', filler);
    const { x, requests } = extractor(honestModel(), { maxRequestBytes: 1, maxPieceBytes: 1500 });
    const result = await x.analyze('300', '', signal());
    expect(result.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.every(r => payloadOf(r).part?.match(/^\d+ of \d+\./))).toBe(true);
    // The promise line sits in two overlapping parts, but is saved once.
    const parts = requests.filter(r => payloadOf(r).transcript.some(l => l.includes("I'll send you the API docs")));
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(store.items({ recordingId: '300', kinds: ['commitment'] })).toHaveLength(1);
    const detail = store.detail('300');
    expect(detail?.summary?.headline).toBe('Part 1');
    expect(detail?.summary?.direction.filter(d => d === 'Ship the archive filter next release')).toHaveLength(1);
  });

  it('retries once with half-size pieces when the provider rejects a request', async () => {
    importMeeting('100');
    let first = true;
    const { x, requests } = extractor(req => {
      if (first) { first = false; throw new PlanningFailure('provider_restricted'); }
      return honestModel()(req);
    });
    const result = await x.analyze('100', '', signal());
    expect(result).toMatchObject({ ok: true });
    expect(payloadOf(requests[0]!).part).toBeUndefined();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.slice(1).every(r => payloadOf(r).part !== undefined)).toBe(true);
  });

  it('keeps a meeting ready for the next check after a passing failure', async () => {
    importMeeting('100');
    const down = extractor(() => { throw new PlanningFailure('provider_error'); });
    expect(await down.x.analyze('100', '', signal())).toEqual({ ok: false, error: 'provider_error' });
    expect(store.meeting('100')).toMatchObject({ status: 'imported', error: 'The model service failed; DAVE will try again later' });
    await extractor(honestModel()).x.analyze('100', '', signal());
    // A failed re-analysis keeps the earlier results visible.
    const restricted = extractor(() => { throw new PlanningFailure('provider_restricted'); });
    expect(await restricted.x.analyze('100', '', signal())).toEqual({ ok: false, error: 'provider_restricted' });
    expect(store.meeting('100')).toMatchObject({ status: 'analyzed', error: 'The model refused or limited this request' });
    expect(store.items({ recordingId: '100' })).toHaveLength(4);
  });

  it('marks an earlier promise as "looks done" from a later meeting, never done', async () => {
    importMeeting('100');
    await extractor(honestModel()).x.analyze('100', '', signal());
    const promise = store.items({ kinds: ['commitment'] })[0]!;
    const later: FathomTranscriptEntry[] = [
      { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:00:05', text: 'Thanks for sending the API docs on Friday, the team is already using them.' },
      { speaker: 'Dave Owner', email: 'dave@studio.dev', timestamp: '00:00:15', text: 'Great, glad they helped with the data pulls.' },
    ];
    importMeeting('400', later, '2026-10-05T16:00:00.000Z');
    const { x, requests } = extractor(honestModel(p => ({
      status_updates: p.open_promises.map(c => ({ commitment: c.handle, status: 'done', quote: 'Thanks for sending the API docs on Friday', turn: 'T1' })),
    })));
    await x.analyze('400', '', signal());
    expect(payloadOf(requests[0]!).open_promises).toEqual([{ handle: 'C1', project: 'P1', text: 'Send the API docs', promised_on: '2026-09-28', due: '2026-10-02' }]);
    expect(store.item(promise.id)).toMatchObject({ status: 'looks_done', statusSource: 'meeting', suggestedStatus: 'done' });
    expect(store.item(promise.id)?.statusNote).toBe('Sounds done in "Meeting 400" at 00:00:05. Jane Client: "Thanks for sending the API docs on Friday"');

    // "Not yet" reopens it, and re-analyzing the same meeting does not suggest it again.
    expect(store.resolveSuggestion(promise.id, 'not_yet', NOW.toISOString())).toBe(true);
    expect(store.item(promise.id)).toMatchObject({ status: 'open', statusSource: 'user', suggestedStatus: null });
    await x.analyze('400', '', signal());
    expect(store.item(promise.id)?.status).toBe('open');

    // A different later meeting is new evidence and may suggest it again; confirming closes it.
    importMeeting('401', later, '2026-10-06T16:00:00.000Z');
    await extractor(honestModel(p => ({
      status_updates: p.open_promises.map(c => ({ commitment: c.handle, status: 'dropped', quote: 'Thanks for sending the API docs on Friday', turn: 'T1' })),
    }))).x.analyze('401', '', signal());
    expect(store.item(promise.id)).toMatchObject({ status: 'looks_done', suggestedStatus: 'dropped' });
    expect(store.resolveSuggestion(promise.id, 'confirm', NOW.toISOString())).toBe(true);
    expect(store.item(promise.id)).toMatchObject({ status: 'dropped', statusSource: 'user', suggestedStatus: null });
    expect(store.resolveSuggestion(promise.id, 'confirm', NOW.toISOString())).toBe(false);
  });

  it('never applies a status update to a promise the owner already closed', async () => {
    importMeeting('100');
    await extractor(honestModel()).x.analyze('100', '', signal());
    const promise = store.items({ kinds: ['commitment'] })[0]!;
    expect(store.suggestStatus(promise.id, { status: 'done', source: 'meeting', evidence: [], note: 'n' }, NOW.toISOString())).toBe(false);
    store.setItemStatus(promise.id, { status: 'dropped', source: 'user', note: null }, NOW.toISOString());
    expect(store.suggestStatus(promise.id, { status: 'done', source: 'meeting', evidence: ['meeting:9'], note: 'n' }, NOW.toISOString())).toBe(false);
    expect(store.item(promise.id)?.status).toBe('dropped');
  });

  it('never treats promises from later meetings as earlier ones', async () => {
    importMeeting('500', ENTRIES, '2026-10-10T16:00:00.000Z');
    await extractor(honestModel()).x.analyze('500', '', signal());
    importMeeting('100');
    const { x, requests } = extractor(honestModel());
    await x.analyze('100', '', signal());
    expect(payloadOf(requests[0]!).open_promises).toEqual([]);
  });

  it('saves nothing when the meeting was forgotten during analysis', async () => {
    importMeeting('100');
    const { x } = extractor(req => { store.forget('100', NOW.toISOString()); return honestModel()(req); });
    expect(await x.analyze('100', '', signal())).toEqual({ ok: false, error: 'cancelled' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_items').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_extractions').get()).toMatchObject({ n: 0 });
  });

  it('refuses to analyze a meeting without a transcript', async () => {
    store.upsertMeeting(meetingFixture('600'), NOW.toISOString());
    const { x, requests } = extractor(honestModel());
    expect(await x.analyze('600', '', signal())).toEqual({ ok: false, error: 'no_transcript' });
    expect(requests).toHaveLength(0);
  });
});

describe('meetings with nothing to read', () => {
  it('marks an imported meeting whose transcript has no usable lines as failed, so the queue moves on', async () => {
    const empty: FathomTranscriptEntry[] = [{ speaker: 'Jane', email: null, timestamp: 'bad', text: 'unusable line' }];
    importMeeting('300', empty);
    const { x, requests } = extractor(honestModel());
    expect(await x.analyze('300', '', signal())).toEqual({ ok: false, error: 'no_transcript' });
    expect(requests).toHaveLength(0);
    expect(store.meeting('300')).toMatchObject({ status: 'failed', error: 'There is no transcript to analyze' });
    expect(store.analysisQueue(10)).toEqual([]);
  });
});

describe('forgetting during analysis', () => {
  it('saves nothing when the meeting is forgotten while the model is working', async () => {
    importMeeting('500');
    let release!: (answer: string) => void;
    const { x } = extractor(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = x.analyze('500', '', signal());
    await new Promise(r => setTimeout(r, 5));
    expect(store.forget('500', NOW.toISOString())).toBe(true);
    release(honestModel()({ user: JSON.stringify({ transcript: ENTRIES.map((e, i) => `[T${i + 1}] ${e.timestamp} ${e.speaker} (${i % 2 ? 'me' : 'client'}): ${e.text}`), projects: [], open_promises: [], meeting: {} }) } as InferenceRequest));
    await pending;
    expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_items WHERE recording_id = '500'").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_extractions WHERE recording_id = '500'").get()).toMatchObject({ n: 0 });
    expect(store.meeting('500')).toMatchObject({ status: 'forgotten', title: 'Forgotten meeting' });
  });
});
