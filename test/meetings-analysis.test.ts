import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import { memoryKeyStore } from '../src/meetings/credentials.ts';
import { DISCLOSURE_VERSION } from '../src/meetings/disclosure.ts';
import type { FathomTranscriptEntry } from '../src/meetings/fathom-client.ts';
import { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS_CHARS } from '../src/meetings/prompt.ts';
import { createMeetingService, MAX_AUTO_ANALYSES, MAX_BULK_REANALYSES, MeetingError, type MeetingService } from '../src/meetings/service.ts';
import { transcriptHash } from '../src/meetings/transcript.ts';
import { PlanningFailure, type InferenceRequest } from '../src/providers/openai.ts';
import { meetingFixture } from './meeting-fixtures.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const ENTRIES: FathomTranscriptEntry[] = [
  { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:00:05', text: 'The CSV export keeps timing out when we pick a full year of invoices.' },
  { speaker: 'Dave Owner', email: 'dave@studio.dev', timestamp: '00:00:20', text: "I'll send you the API docs by Friday so your team can pull the data." },
];
const EMPTY_ANSWER = JSON.stringify({ summary: { headline: 'Sync', overview: 'o', direction: [] }, my_commitments: [], client_suggestions: [], client_pain_points: [], decisions: [], status_updates: [] });

let home: string;
let db: Db;
let services: MeetingService[];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-meeting-analysis-'));
  db = openDb(home);
  services = [];
});
afterEach(async () => {
  for (const s of services) await s.close();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

type Model = { calls: InferenceRequest[]; maxInFlight: number; answer: (req: InferenceRequest) => Promise<string> };

function setup(options: { connected?: boolean; answer?: (req: InferenceRequest) => Promise<string> } = {}) {
  const model: Model = { calls: [], maxInFlight: 0, answer: options.answer ?? (async () => EMPTY_ANSWER) };
  let inFlight = 0;
  let connected = options.connected ?? true;
  // An empty Fathom account: a sync lists nothing, then runs the automatic pass.
  const fetch = (async () => Response.json({ limit: null, next_cursor: null, items: [] })) as typeof globalThis.fetch;
  const service = createMeetingService(db, {
    keyStore: memoryKeyStore('fathom-test-key-0123456789abcdef'),
    fetch,
    now: () => NOW,
    openAIConnected: () => connected,
    inference: async req => {
      model.calls.push(req);
      inFlight++;
      model.maxInFlight = Math.max(model.maxInFlight, inFlight);
      try { return await model.answer(req); } finally { inFlight--; }
    },
  });
  services.push(service);
  service.store.updateSettings({ fathomEmail: 'dave@studio.dev' }, NOW.toISOString());
  service.store.setConnectedAt(NOW.toISOString(), NOW.toISOString());
  return { service, model, setConnected: (v: boolean) => { connected = v; } };
}

function importMeetings(service: MeetingService, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = String(1000 + i);
    const startedAt = new Date(NOW.getTime() - (count - i + 1) * 3_600_000).toISOString();
    service.store.upsertMeeting(meetingFixture(id, { startedAt, createdAt: startedAt }), NOW.toISOString());
    service.store.saveTranscript(id, ENTRIES, { hash: transcriptHash(ENTRIES), bytes: 200, status: 'imported', skipReason: null }, NOW.toISOString());
    ids.push(id);
  }
  return ids;
}

const statuses = (service: MeetingService): string[] => service.store.list().map(m => m.status);

describe('analysis switch', () => {
  it('is off by default and never calls the model while off', async () => {
    const { service, model } = setup();
    importMeetings(service, 3);
    expect(service.status().analysis).toMatchObject({ on: false, consentOutdated: false, openAIConnected: true, disclosure: { version: DISCLOSURE_VERSION } });
    service.setAnalysis(false, undefined);
    await service.idle();
    expect(model.calls).toHaveLength(0);
    expect(statuses(service)).toEqual(['imported', 'imported', 'imported']);
  });

  it('refuses to turn on without consent to the current disclosure', async () => {
    const { service, model } = setup();
    importMeetings(service, 1);
    for (const version of [undefined, '', 'older-version']) {
      expect(() => service.setAnalysis(true, version)).toThrow(MeetingError);
    }
    await service.idle();
    expect(service.store.settings()).toMatchObject({ autoExtract: false, consentVersion: null });
    expect(model.calls).toHaveLength(0);
  });

  it('stops automatic analysis when the disclosure changed since consent', async () => {
    const { service, model } = setup();
    importMeetings(service, 1);
    service.store.setAutoExtract(true, 'an-older-disclosure', NOW.toISOString());
    expect(service.status().analysis).toMatchObject({ on: false, consentOutdated: true });
    service.syncNow();
    await service.idle();
    expect(model.calls).toHaveLength(0);
    // The same sync with current consent does analyze.
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    service.syncNow();
    await service.idle();
    expect(model.calls).toHaveLength(1);
  });

  it('does not analyze automatically while OpenAI is not connected', async () => {
    const { service, model, setConnected } = setup({ connected: false });
    importMeetings(service, 2);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls).toHaveLength(0);
    expect(service.status().analysis).toMatchObject({ on: true, openAIConnected: false });
    setConnected(true);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls).toHaveLength(2);
  });

  it('analyzes at most ten meetings per check, one at a time, oldest first', async () => {
    const { service, model } = setup({ answer: async () => { await new Promise(r => setTimeout(r, 2)); return EMPTY_ANSWER; } });
    const ids = importMeetings(service, MAX_AUTO_ANALYSES + 3);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls).toHaveLength(MAX_AUTO_ANALYSES);
    expect(model.maxInFlight).toBe(1);
    const analyzed = service.store.list().filter(m => m.status === 'analyzed').map(m => m.recordingId).sort();
    expect(analyzed).toEqual(ids.slice(0, MAX_AUTO_ANALYSES).sort());
    expect(model.calls.every(c => c.cacheKey === 'dave-meetings-v1' && c.timeoutMs === 300_000)).toBe(true);
  });

  it('stops the pass after a passing failure instead of repeating it for every meeting', async () => {
    const { service, model } = setup({ answer: async () => { throw new PlanningFailure('provider_error'); } });
    importMeetings(service, 4);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls).toHaveLength(1);
    expect(statuses(service)).toEqual(['imported', 'imported', 'imported', 'imported']);
  });

  it('turning the switch off aborts the analysis in flight and sends nothing more', async () => {
    let seen: AbortSignal | null = null;
    let release!: () => void;
    const { service, model } = setup({ answer: req => new Promise((resolve, reject) => {
      seen = req.signal;
      release = () => resolve(EMPTY_ANSWER);
      req.signal.addEventListener('abort', () => reject(new PlanningFailure('cancelled')), { once: true });
    }) });
    importMeetings(service, 3);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await new Promise(r => setTimeout(r, 5));
    expect(model.calls).toHaveLength(1);
    service.setAnalysis(false, undefined);
    await service.idle();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(statuses(service)).toEqual(['imported', 'imported', 'imported']);
    void release;
  });
});

describe('reading instructions', () => {
  it('starts from the default, saves versions and resets', () => {
    const { service } = setup();
    const initial = service.instructions();
    expect(initial).toMatchObject({ id: null, source: 'default', instructions: DEFAULT_INSTRUCTIONS });
    const saved = service.saveInstructions('  Track design feedback.\r\nIgnore pricing.\u0007  ');
    expect(saved).toMatchObject({ source: 'user', instructions: 'Track design feedback.\nIgnore pricing.' });
    expect(saved.hash).not.toBe(initial.hash);
    // Saving the same text again does not add a version.
    expect(service.saveInstructions('Track design feedback.\nIgnore pricing.').id).toBe(saved.id);
    const reset = service.resetInstructions();
    expect(reset).toMatchObject({ source: 'default', instructions: DEFAULT_INSTRUCTIONS, hash: initial.hash });
  });

  it.each([
    ['a number', 42, 'must be text'],
    ['blank text', '   ', 'Write some instructions'],
    ['text over the limit', 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1), `${MAX_INSTRUCTIONS_CHARS} characters`],
  ])('rejects %s', (_, input, message) => {
    const { service } = setup();
    expect(() => service.saveInstructions(input)).toThrow(message);
  });

  it('flags meetings analyzed with older instructions and re-analyzes at most ten per request', async () => {
    const { service, model } = setup();
    const ids = importMeetings(service, MAX_BULK_REANALYSES + 2);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    service.setAnalysis(true, DISCLOSURE_VERSION);
    await service.idle();
    expect(service.list().every(m => m.status === 'analyzed' && !m.staleInstructions)).toBe(true);
    service.setAnalysis(false, undefined);

    service.saveInstructions('Only track promises about the export.');
    expect(service.list().every(m => m.staleInstructions)).toBe(true);
    expect(service.detail(ids[0]!).staleInstructions).toBe(true);
    const before = model.calls.length;
    expect(() => service.reanalyzeStale(undefined)).toThrow('Review what DAVE sends');
    service.reanalyzeStale(DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls.length - before).toBe(MAX_BULK_REANALYSES);
    expect(model.calls.at(-1)?.system).toContain('Only track promises about the export.');
    // Newest first: the two oldest are still flagged.
    expect(service.list().filter(m => m.staleInstructions).map(m => m.recordingId).sort()).toEqual(ids.slice(0, 2).sort());
  });
});

describe('one-off analysis', () => {
  it('needs the reviewed disclosure version when the switch is off', async () => {
    const { service, model } = setup();
    const [id] = importMeetings(service, 1);
    expect(() => service.analyze(id!, undefined)).toThrow('Review what DAVE sends');
    expect(() => service.analyze(id!, 'an-older-disclosure')).toThrow('Review what DAVE sends');
    await service.idle();
    expect(model.calls).toHaveLength(0);
    service.analyze(id!, DISCLOSURE_VERSION);
    await service.idle();
    expect(model.calls).toHaveLength(1);
    expect(statuses(service)).toEqual(['analyzed']);
    // A one-off analysis does not turn the switch on.
    expect(service.status().analysis.on).toBe(false);
  });

  it('runs without a version once the switch is on, and ignores duplicate requests', async () => {
    const { service, model } = setup({ connected: false });
    const [id] = importMeetings(service, 1);
    service.setAnalysis(true, DISCLOSURE_VERSION);
    service.analyze(id!, undefined);
    service.analyze(id!, undefined);
    await service.idle();
    expect(model.calls).toHaveLength(1);
  });

  it('rejects meetings without a transcript and unknown ids', () => {
    const { service } = setup();
    service.store.upsertMeeting(meetingFixture('77'), NOW.toISOString());
    expect(() => service.analyze('77', DISCLOSURE_VERSION)).toThrow('no transcript');
    expect(() => service.analyze('12345', DISCLOSURE_VERSION)).toThrow('Unknown meeting');
    expect(() => service.analyze('../x', DISCLOSURE_VERSION)).toThrow('Unknown meeting');
  });

  it('sends a skipped or unavailable meeting back to the transcript queue', () => {
    const { service } = setup();
    service.store.upsertMeeting(meetingFixture('88'), NOW.toISOString());
    service.store.skipMeeting('88', 'Title contains "standup"', NOW.toISOString());
    service.retry('88');
    expect(service.store.meeting('88')).toMatchObject({ status: 'waiting', skipReason: null, transcriptAttempts: 0 });
    expect(() => service.retry('88')).toThrow('Only skipped or unavailable');
  });
});

describe('owner decisions on items', () => {
  const ITEM = 'mi-0123456789abcdef01234567';
  function withPromise(service: MeetingService): void {
    const [id] = importMeetings(service, 1);
    db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, status, created_at, updated_at)
      VALUES (?, ?, 'commitment', 'Send the API docs', 'I''ll send the API docs', 20, 'Dave Owner', 'me', 'open', ?, ?)`)
      .run(ITEM, id!, NOW.toISOString(), NOW.toISOString());
  }

  it('validates the item and the action', () => {
    const { service } = setup();
    withPromise(service);
    expect(() => service.setItemStatus('mi-nothex', 'done')).toThrow('Unknown item');
    expect(() => service.setItemStatus('mi-ffffffffffffffffffffffff', 'done')).toThrow('Unknown item');
    expect(() => service.setItemStatus(ITEM, 'closed')).toThrow('Choose done');
    expect(() => service.setItemStatus(ITEM, 'confirm')).toThrow('not waiting for a decision');
  });

  it('lets the owner close, reopen, confirm or reject a suggestion', () => {
    const { service } = setup();
    withPromise(service);
    expect(service.setItemStatus(ITEM, 'done')).toMatchObject({ status: 'done', statusSource: 'user' });
    expect(service.setItemStatus(ITEM, 'open')).toMatchObject({ status: 'open' });
    service.store.suggestStatus(ITEM, { status: 'done', source: 'evidence', evidence: ['commit:abc'], note: 'A commit mentions the docs' }, NOW.toISOString());
    expect(service.setItemStatus(ITEM, 'not_yet')).toMatchObject({ status: 'open', suggestedStatus: null });
    // The same evidence is not suggested again; new evidence is.
    expect(service.store.suggestStatus(ITEM, { status: 'done', source: 'evidence', evidence: ['commit:abc'], note: 'again' }, NOW.toISOString())).toBe(false);
    expect(service.store.suggestStatus(ITEM, { status: 'done', source: 'evidence', evidence: ['commit:abc', 'run:r1'], note: 'new' }, NOW.toISOString())).toBe(true);
    expect(service.setItemStatus(ITEM, 'confirm')).toMatchObject({ status: 'done', statusSource: 'user' });
  });
});

describe('client ideas and agent runs', () => {
  const IDEA = 'mi-abcdefabcdefabcdefabcdef';
  const RUN = '12345678-1234-1234-1234-123456789abc';
  const OTHER_RUN = '12345678-1234-1234-1234-123456789abd';
  function withIdea(service: MeetingService): void {
    const [id] = importMeetings(service, 1);
    db.exec("INSERT OR IGNORE INTO projects VALUES('p1','/work/acme','Acme','2026-01-01','2026-01-01')");
    db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, feature_json, status, created_at, updated_at)
      VALUES (?, ?, 'pain_point', 'Export times out', 'The CSV export keeps timing out', 5, 'Jane Client', 'client', 'p1', ?, 'open', ?, ?)`)
      .run(IDEA, id!, JSON.stringify({ title: 'Background export', outcome: 'Exports finish', acceptance: ['a', 'b'] }), NOW.toISOString(), NOW.toISOString());
  }
  const addRun = (id: string, status: string) => db.prepare(`INSERT INTO agent_runs(id, project_id, request_key, request_json, title, prompt, criteria_json, checks_json, status, branch, next_prompt, created_at, updated_at)
    VALUES (?, 'p1', ?, '{}', 'Background export', 'p', '[]', '[]', ?, ?, '', ?, ?)`).run(id, `k-${id}`, status, `dave/${id}`, NOW.toISOString(), NOW.toISOString());
  const setRun = (id: string, status: string) => db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run(status, id);

  it('builds a draft, links the started run, and asks "Delivered?" once the run is accepted', () => {
    const { service } = setup();
    withIdea(service);
    expect(service.assignment(IDEA)).toMatchObject({ projectId: 'p1', title: 'Background export', criteria: ['a', 'b'] });
    addRun(RUN, 'queued');
    expect(service.linkRun(IDEA, RUN)).toMatchObject({ status: 'planned', agentRunId: RUN, statusNote: 'Agent run queued: Background export' });
    // Retrying the same link is harmless.
    expect(service.linkRun(IDEA, RUN)).toMatchObject({ status: 'planned' });

    setRun(RUN, 'review');
    expect(service.items({ kinds: ['pain_point'], statuses: ['planned'] }).map(i => i.id)).toEqual([IDEA]);
    setRun(RUN, 'accepted');
    const [idea] = service.items({ kinds: ['pain_point'], statuses: ['looks_done'] });
    expect(idea).toMatchObject({ id: IDEA, status: 'looks_done', statusSource: 'agent', suggestedStatus: 'done', statusNote: 'Agent run accepted: Background export' });
    // Never closed on its own: the owner confirms.
    expect(service.setItemStatus(IDEA, 'confirm')).toMatchObject({ status: 'done', statusSource: 'user' });
  });

  it('reopens the idea when its run is stopped, so another run can be linked', () => {
    const { service } = setup();
    withIdea(service);
    addRun(RUN, 'queued');
    addRun(OTHER_RUN, 'queued');
    service.linkRun(IDEA, RUN);
    expect(() => service.linkRun(IDEA, OTHER_RUN)).toThrow('already planned');
    setRun(RUN, 'stopped');
    expect(service.items({ kinds: ['pain_point'], statuses: ['open'] })[0]).toMatchObject({ id: IDEA, status: 'open', statusNote: 'The agent run was stopped' });
    expect(service.linkRun(IDEA, OTHER_RUN)).toMatchObject({ status: 'planned', agentRunId: OTHER_RUN });
  });

  it('refuses bad ids, unknown runs, promises and runs linked elsewhere', () => {
    const { service } = setup();
    withIdea(service);
    addRun(RUN, 'queued');
    expect(() => service.linkRun(IDEA, 'not-a-run')).toThrow('Invalid run');
    expect(() => service.linkRun(IDEA, OTHER_RUN)).toThrow('Unknown item or run');
    expect(() => service.linkRun('mi-nope', RUN)).toThrow('Unknown item');
    const second = 'mi-bcdefabcdefabcdefabcdefa';
    db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, feature_json, status, created_at, updated_at)
      SELECT ?, recording_id, kind, 'Another idea', 'Another quote from the client', at_seconds, speaker, speaker_role, project_id, feature_json, 'open', created_at, updated_at FROM meeting_items WHERE id = ?`).run(second, IDEA);
    service.linkRun(IDEA, RUN);
    expect(() => service.linkRun(second, RUN)).toThrow('linked to another idea');
    const promise = 'mi-cdefabcdefabcdefabcdefab';
    db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, status, created_at, updated_at)
      SELECT ?, recording_id, 'commitment', 'Send docs', 'I will send the docs', 1, 'Dave', 'me', 'open', created_at, updated_at FROM meeting_items WHERE id = ?`).run(promise, IDEA);
    expect(() => service.linkRun(promise, OTHER_RUN)).toThrow('Only a client idea');
    expect(() => service.assignment(promise)).toThrow('Only a client pain point');
  });
});

describe('projects, rules and corrections', () => {
  const projects = [{ id: 'p1', name: 'Acme', path: '/work/acme', focus: null }, { id: 'p2', name: 'Beta', path: '/work/beta', focus: null }];
  function withProjects() {
    db.exec("INSERT OR IGNORE INTO projects VALUES('p1','/work/acme','Acme','2026-01-01','2026-01-01'); INSERT OR IGNORE INTO projects VALUES('p2','/work/beta','Beta','2026-01-01','2026-01-01')");
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/transcript')) return Response.json({ transcript: [] });
      return Response.json({ next_cursor: null, items: [{ title: 'Acme sync', recording_id: 777, url: 'https://fathom.video/calls/777', created_at: '2026-09-29T10:00:00Z',
        calendar_invitees: [{ name: 'Jane', email: 'jane@acme.com', email_domain: 'acme.com', is_external: true }], recorded_by: { email: 'dave@studio.dev' } }] });
    }) as typeof globalThis.fetch;
    const service = createMeetingService(db, { keyStore: memoryKeyStore('fathom-test-key-0123456789abcdef'), fetch, now: () => NOW, projects: () => projects, openAIConnected: () => false });
    services.push(service);
    service.store.updateSettings({ fathomEmail: 'dave@studio.dev' }, NOW.toISOString());
    service.store.setConnectedAt(NOW.toISOString(), NOW.toISOString());
    return service;
  }

  it('sets a meeting project, moves items that follow it, and remembers the company for next time', async () => {
    const service = withProjects();
    const [id] = importMeetings(service, 1);
    const insert = db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, project_source, status, created_at, updated_at)
      VALUES (?, ?, 'commitment', 't', ?, 1, 'Dave', 'me', ?, ?, 'open', ?, ?)`);
    insert.run('mi-000000000000000000000001', id!, 'quote one here', null, null, NOW.toISOString(), NOW.toISOString());
    insert.run('mi-000000000000000000000002', id!, 'quote two here', 'p2', 'model', NOW.toISOString(), NOW.toISOString());
    expect(() => service.setMeetingProject(id!, { projectId: 'nope', remember: false })).toThrow('Unknown project');
    expect(() => service.setMeetingProject('12a', { projectId: 'p1', remember: false })).toThrow('Unknown meeting');
    const detail = service.setMeetingProject(id!, { projectId: 'p1', remember: true });
    expect(detail).toMatchObject({ projectId: 'p1', projectSource: 'user' });
    expect(service.store.item('mi-000000000000000000000001')).toMatchObject({ projectId: 'p1', projectSource: 'meeting' });
    expect(service.store.item('mi-000000000000000000000002')).toMatchObject({ projectId: 'p2', projectSource: 'model' });
    expect(service.rules()).toMatchObject([{ kind: 'domain', pattern: 'acme.com', projectId: 'p1', projectName: 'Acme' }]);

    // The next meeting with someone from acme.com gets the project at import.
    service.syncNow();
    await service.idle();
    expect(service.store.meeting('777')).toMatchObject({ projectId: 'p1', projectSource: 'rule' });

    const [rule] = service.rules();
    expect(service.deleteRule(rule!.id)).toEqual([]);
    expect(() => service.deleteRule(rule!.id)).toThrow('Unknown rule');
  });

  it('validates and saves the owner corrections as edited', async () => {
    const service = withProjects();
    const [id] = importMeetings(service, 1);
    const itemId = 'mi-000000000000000000000003';
    db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, status, created_at, updated_at)
      VALUES (?, ?, 'commitment', 'Send docs', 'I will send the docs', 1, 'Dave', 'me', 'open', ?, ?)`).run(itemId, id!, NOW.toISOString(), NOW.toISOString());
    expect(() => service.editItem(itemId, { dueDate: '10/02/2026' })).toThrow('YYYY-MM-DD');
    expect(() => service.editItem(itemId, { text: '' })).toThrow('1 to 600');
    expect(() => service.editItem(itemId, { projectId: 'nope' })).toThrow('Unknown project');
    expect(service.editItem(itemId, { text: 'Send the REST docs', dueDate: '2026-10-09', projectId: 'p2' }))
      .toMatchObject({ text: 'Send the REST docs', dueDate: '2026-10-09', projectId: 'p2', projectSource: 'user', edited: true });
  });
});
