import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import type { DatedCommit } from '../src/adapters/git.ts';
import { memoryKeyStore } from '../src/meetings/credentials.ts';
import { DISCLOSURE_VERSION } from '../src/meetings/disclosure.ts';
import { gatherEvidence, parseFollowup } from '../src/meetings/followup.ts';
import { createMeetingService, type MeetingService } from '../src/meetings/service.ts';
import { PlanningFailure, type InferenceRequest } from '../src/providers/openai.ts';
import type { PortfolioProject } from '../src/shared/types.ts';
import { meetingFixture } from './meeting-fixtures.ts';
import { project as projectFixture, task } from './helpers.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const MEETING_AT = '2026-09-20T16:00:00.000Z';
const PROJECT: PortfolioProject = projectFixture({ id: 'p1', name: 'Acme', canonicalPath: '/work/acme', tasks: [
  task({ id: 'ez1', title: 'Publish API docs', status: 'done', source: 'ezboss-plan', updatedAt: '2026-09-25T10:00:00.000Z' }),
  task({ id: 'ec1', title: 'EZ Coder internal task', status: 'done', source: 'ezcoder-tasks', updatedAt: '2026-09-25T10:00:00.000Z' }),
  task({ id: 'ez2', title: 'Old done task', status: 'done', source: 'ezboss-plan', updatedAt: '2026-09-01T10:00:00.000Z' }),
] });
const COMMITS: DatedCommit[] = [
  { at: '2026-09-27T09:00:00.000Z', subject: 'docs: publish API reference for Acme' },
  { at: '2026-09-10T09:00:00.000Z', subject: 'old commit before the meeting' },
];

let home: string;
let db: Db;
let services: MeetingService[];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-meeting-followup-'));
  db = openDb(home);
  db.exec("INSERT INTO projects VALUES('p1','/work/acme','Acme','2026-01-01','2026-01-01')");
  services = [];
});
afterEach(async () => {
  for (const s of services) await s.close();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const EMPTY_ANALYSIS = JSON.stringify({ summary: { headline: 'h', overview: 'o', direction: [] }, my_commitments: [], client_suggestions: [], client_pain_points: [], decisions: [], status_updates: [] });

function setup(options: { connected?: boolean; answer?: (req: InferenceRequest) => string; commits?: DatedCommit[] } = {}) {
  const calls: InferenceRequest[] = [];
  const gitCalls: string[] = [];
  const commits = options.commits ?? [...COMMITS];
  const service = createMeetingService(db, {
    keyStore: memoryKeyStore(),
    now: () => NOW,
    openAIConnected: () => options.connected ?? true,
    portfolioProjects: () => [PROJECT],
    commits: async p => { gitCalls.push(p); return commits; },
    inference: async req => {
      calls.push(req);
      if (req.cacheKey === 'dave-meetings-v1') return EMPTY_ANALYSIS;
      return options.answer?.(req) ?? JSON.stringify({ done: [{ promise: 'C1', evidence: ['E1'] }] });
    },
  });
  services.push(service);
  service.store.upsertMeeting(meetingFixture('100', { startedAt: MEETING_AT, createdAt: MEETING_AT }), NOW.toISOString());
  db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, status, created_at, updated_at)
    VALUES ('mi-0123456789abcdef01234567', '100', 'commitment', 'Send the API docs', 'I''ll send the API docs', 20, 'Dave', 'me', 'p1', 'open', ?, ?)`)
    .run(NOW.toISOString(), NOW.toISOString());
  return { service, calls, gitCalls, commits, item: () => service.store.item('mi-0123456789abcdef01234567') };
}

describe('follow-up check refuses without consent', () => {
  it.each([
    ['the switch is off', (s: MeetingService) => { void s; }],
    ['the consent version is outdated', (s: MeetingService) => { s.store.setAutoExtract(true, 'an-older-disclosure', NOW.toISOString()); }],
  ])('makes no model call and changes no promise when %s', async (_, arrange) => {
    const { service, calls, gitCalls, item } = setup();
    arrange(service);
    await service.runFollowup();
    expect(calls).toHaveLength(0);
    expect(gitCalls).toHaveLength(0);
    expect(item()?.status).toBe('open');
  });

  it('makes no model call when OpenAI is disconnected, even with the switch on', async () => {
    const { service, calls, gitCalls, item } = setup({ connected: false });
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    await service.runFollowup();
    expect(calls).toHaveLength(0);
    expect(gitCalls).toHaveLength(0);
    expect(item()?.status).toBe('open');
  });

  it('is not enabled by a one-off Analyze consent', async () => {
    const { service, calls, gitCalls, item } = setup();
    const entries = [{ speaker: 'Jane', email: 'jane@acme.com', timestamp: '00:00:05', text: 'The export keeps timing out on large ranges.' }];
    service.store.upsertMeeting(meetingFixture('200'), NOW.toISOString());
    service.store.saveTranscript('200', entries, { hash: 'h', bytes: 50, status: 'imported', skipReason: null }, NOW.toISOString());
    service.analyze('200', DISCLOSURE_VERSION);
    await service.idle();
    expect(calls.map(c => c.cacheKey)).toEqual(['dave-meetings-v1']);
    // One-off consent is passed per request and never stored.
    expect(service.store.settings()).toMatchObject({ autoExtract: false, consentVersion: null });
    await service.runFollowup();
    expect(calls).toHaveLength(1);
    expect(gitCalls).toHaveLength(0);
    expect(item()?.status).toBe('open');
  });
});

describe('follow-up check with consent', () => {
  it('sends only titles and dates, and marks the promise "Looks done?" without closing it', async () => {
    const { service, calls, item } = setup();
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    await service.runFollowup();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]!.user) as { project: string; promises: unknown[]; evidence: { title: string; kind: string }[] };
    expect(payload.project).toBe('Acme');
    expect(payload.promises).toEqual([{ handle: 'C1', text: 'Send the API docs', promised_on: '2026-09-20' }]);
    // Newest first; nothing from before the meeting; EZ Coder's own tasks excluded.
    expect(payload.evidence.map(e => [e.kind, e.title])).toEqual([
      ['commit', 'docs: publish API reference for Acme'],
      ['task', 'Publish API docs'],
    ]);
    expect(calls[0]!.user).not.toContain('/work/acme');
    expect(item()).toMatchObject({ status: 'looks_done', statusSource: 'evidence', suggestedStatus: 'done' });
    expect(item()?.statusNote).toContain('Commit "docs: publish API reference for Acme"');

    // Due again only after six hours.
    await service.runFollowup();
    expect(calls).toHaveLength(1);
  });

  it('only asks again when new evidence arrives, and never re-suggests evidence the owner rejected', async () => {
    let answer = JSON.stringify({ done: [] });
    const { service, calls, commits, item } = setup({ answer: () => answer });
    const due = () => service.store.updateSyncState({ followupAt: null });
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    await service.runFollowup();
    expect(calls).toHaveLength(1);
    due();
    await service.runFollowup();
    expect(calls).toHaveLength(1);

    // New evidence arrives: asked again, and the model cites the release commit.
    commits.unshift({ at: '2026-09-28T09:00:00.000Z', subject: 'release: ship API docs site' });
    answer = JSON.stringify({ done: [{ promise: 'C1', evidence: ['E1'] }] });
    due();
    await service.runFollowup();
    expect(calls).toHaveLength(2);
    expect(item()).toMatchObject({ status: 'looks_done', statusNote: expect.stringContaining('release: ship API docs site') });
    service.setItemStatus(item()!.id, 'not_yet');

    // Unchanged evidence: nothing is sent.
    due();
    await service.runFollowup();
    expect(calls).toHaveLength(2);

    // More evidence arrives, but the model cites only the rejected commit (now E2): no suggestion.
    commits.unshift({ at: '2026-09-29T09:00:00.000Z', subject: 'chore: bump deps' });
    answer = JSON.stringify({ done: [{ promise: 'C1', evidence: ['E2'] }] });
    due();
    await service.runFollowup();
    expect(calls).toHaveLength(3);
    expect(item()?.status).toBe('open');
  });

  it('ignores invented handles and evidence from before the promise', async () => {
    const { service, item } = setup({ answer: () => JSON.stringify({ done: [{ promise: 'C9', evidence: ['E1'] }, { promise: 'C1', evidence: ['E7'] }] }) });
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    await service.runFollowup();
    expect(item()?.status).toBe('open');
  });

  it('stops when the connection is lost, and tries again at the next check', async () => {
    const { service, calls, item } = setup({ answer: () => { throw new PlanningFailure('connection_required'); } });
    service.store.setAutoExtract(true, DISCLOSURE_VERSION, NOW.toISOString());
    await service.runFollowup();
    expect(calls).toHaveLength(1);
    expect(item()?.status).toBe('open');
    expect(service.store.syncState().followupAt).toBeNull();
    await service.runFollowup();
    expect(calls).toHaveLength(2);
  });
});

describe('follow-up parsing and evidence', () => {
  it.each([
    ['not JSON', 'nope', null],
    ['extra keys', JSON.stringify({ done: [], note: 'x' }), null],
    ['unknown handles dropped', JSON.stringify({ done: [{ promise: 'C2', evidence: ['E1'] }, { promise: 'C1', evidence: ['E9', 'E1', 'E1'] }] }), [{ promise: 'C1', evidence: ['E1'] }]],
    ['no evidence dropped', JSON.stringify({ done: [{ promise: 'C1', evidence: [] }] }), []],
  ])('%s', (_, raw, expected) => {
    expect(parseFollowup(raw, new Set(['C1']), new Set(['E1']))).toEqual(expected);
  });

  it('collects only accepted agent runs finished after the meeting', async () => {
    const run = db.prepare(`INSERT INTO agent_runs(id, project_id, request_key, request_json, title, prompt, criteria_json, checks_json, status, branch, next_prompt, created_at, updated_at)
      VALUES (?, 'p1', ?, '{}', ?, 'p', '[]', '[]', ?, ?, '', ?, ?)`);
    run.run('r1', 'k1', 'Add background export', 'accepted', 'b1', '2026-09-21T00:00:00.000Z', '2026-09-26T08:00:00.000Z');
    run.run('r2', 'k2', 'Rejected attempt', 'failed', 'b2', '2026-09-21T00:00:00.000Z', '2026-09-26T09:00:00.000Z');
    run.run('r3', 'k3', 'Accepted before the call', 'accepted', 'b3', '2026-09-01T00:00:00.000Z', '2026-09-02T09:00:00.000Z');
    const evidence = await gatherEvidence({ db, commits: async () => [] }, PROJECT, MEETING_AT);
    expect(evidence.map(e => [e.kind, e.id, e.title])).toEqual([
      ['run', 'run:r1', 'Add background export'],
      ['task', expect.stringMatching(/^task:[0-9a-f]{16}$/), 'Publish API docs'],
    ]);
  });
});

describe('project meetings overview', () => {
  it('shows the project items, the latest call direction and local work since that call', async () => {
    const { service, calls, gitCalls } = setup();
    service.store.setMeetingProject('100', 'p1', 'user', NOW.toISOString());
    db.prepare(`INSERT INTO meeting_extractions(id, recording_id, instructions_hash, transcript_hash, provider, model, summary_json, created_at)
      VALUES ('e1', '100', 'h', 't', 'openai', 'gpt-6-astra', ?, ?)`).run(JSON.stringify({ headline: 'Docs and export', overview: 'o', direction: ['Ship docs first'] }), NOW.toISOString());
    const overview = await service.projectOverview('p1');
    expect(overview.items.map(i => i.text)).toEqual(['Send the API docs']);
    // Ten days old, but the EZBoss task finished after the call counts as work since.
    expect(overview.promiseStates).toEqual({ 'mi-0123456789abcdef01234567': 'open' });
    expect(overview.lastCall).toEqual({ recordingId: '100', title: 'Meeting 100', at: MEETING_AT, headline: 'Docs and export', direction: ['Ship docs first'] });
    expect(overview.sinceLastCall.map(e => [e.kind, e.title])).toEqual([['commit', 'docs: publish API reference for Acme'], ['task', 'Publish API docs']]);
    // Reading the overview never calls the model.
    expect(calls).toHaveLength(0);
    expect(gitCalls).toEqual(['/work/acme']);
    await expect(service.projectOverview('unknown')).rejects.toThrow('Unknown project');
  });
});
