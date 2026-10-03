import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import { applyInboxAction } from '../src/meetings/attention.ts';
import { MAX_SYNC_RUNS, meetingStore } from '../src/meetings/store.ts';
import { meetingFixture } from './meeting-fixtures.ts';

const NOW = '2026-09-30T12:00:00.000Z';
const ENTRIES = [{ speaker: 'Jane', email: 'jane@acme.com', timestamp: '00:00:05', text: 'SECRET-TRANSCRIPT-TEXT the export is slow' }];

let home: string;
let db: Db;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-meeting-store-'));
  db = openDb(home);
  db.exec("INSERT INTO projects VALUES('p1','/work/acme','Acme','2026-01-01','2026-01-01')");
});
afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

function insertItem(id: string, recordingId: string, over: Record<string, string | number | null> = {}): void {
  const row = { kind: 'commitment', text: 'Send the API docs', quote: "I'll send the API docs", at_seconds: 5, speaker: 'Dave', speaker_role: 'me', project_id: 'p1', status: 'open', ...over };
  db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, recordingId, row.kind, row.text, row.quote, row.at_seconds, row.speaker, row.speaker_role, row.project_id, row.status, NOW, NOW);
}

describe('meeting store', () => {
  it('reads and updates settings, and needs a consent version to turn analysis on', () => {
    const store = meetingStore(db);
    expect(store.settings()).toMatchObject({ fathomEmail: '', historyDays: 30, paused: false, autoExtract: false, consentVersion: null });
    store.updateSettings({ fathomEmail: 'dave@studio.dev', nameAliases: ['Dave O.'], historyDays: 7, ignoreWords: ['standup'] }, NOW);
    expect(store.settings()).toMatchObject({ fathomEmail: 'dave@studio.dev', nameAliases: ['Dave O.'], historyDays: 7, ignoreWords: ['standup'], updatedAt: NOW });
    expect(() => store.setAutoExtract(true, null, NOW)).toThrow('Consent version required');
    store.setAutoExtract(true, 'v1', NOW);
    expect(store.settings()).toMatchObject({ autoExtract: true, consentVersion: 'v1', consentAt: NOW });
    store.setAutoExtract(false, null, NOW);
    expect(store.settings()).toMatchObject({ autoExtract: false, consentVersion: null, consentAt: null });
  });

  it('adds new meetings once and refreshes metadata of known ones', () => {
    const store = meetingStore(db);
    expect(store.upsertMeeting(meetingFixture('100'), NOW)).toBe('added');
    expect(store.upsertMeeting(meetingFixture('100', { title: 'Renamed' }), NOW)).toBe('updated');
    expect(store.meeting('100')).toMatchObject({ title: 'Renamed', status: 'waiting', external: true, attendees: [{ email: 'dave@studio.dev' }, { email: 'jane@acme.com', external: true }] });
    expect(store.pendingTranscripts(NOW, 10).map(m => m.recordingId)).toEqual(['100']);
  });

  it('stores transcripts locally but never includes them in lists or details', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    store.saveTranscript('100', ENTRIES, { hash: 'h1', bytes: 42, status: 'imported', skipReason: null }, NOW);
    expect(store.transcript('100')).toEqual({ hash: 'h1', entries: ENTRIES });
    expect(store.pendingTranscripts(NOW, 10)).toEqual([]);
    expect(JSON.stringify(store.list())).not.toContain('SECRET-TRANSCRIPT-TEXT');
    expect(JSON.stringify(store.detail('100'))).not.toContain('SECRET-TRANSCRIPT-TEXT');
    expect(store.list()[0]).toMatchObject({ recordingId: '100', status: 'imported', transcriptBytes: 42 });
  });

  it('marks a transcript unavailable after the retry window', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    store.transcriptMissing('100', { nextAt: '2026-09-30T12:10:00.000Z', error: 'not ready', unavailable: false }, NOW);
    expect(store.meeting('100')).toMatchObject({ status: 'waiting', transcriptAttempts: 1, transcriptNextAt: '2026-09-30T12:10:00.000Z' });
    expect(store.pendingTranscripts(NOW, 10)).toEqual([]);
    expect(store.pendingTranscripts('2026-09-30T12:10:00.000Z', 10)).toHaveLength(1);
    store.transcriptMissing('100', { nextAt: null, error: 'gone', unavailable: true }, NOW);
    expect(store.meeting('100')).toMatchObject({ status: 'unavailable', error: 'gone' });
  });

  it('retries a skipped meeting: fetches again when no transcript is saved, includes it when one is', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    store.skipMeeting('100', 'Title contains "standup"', NOW);
    expect(store.retryTranscript('100', '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(store.meeting('100')).toMatchObject({ status: 'waiting', skipReason: null, transcriptAttempts: 0, firstSeenAt: '2026-10-01T00:00:00.000Z' });
    expect(store.retryTranscript('100', NOW)).toBe(false);

    store.upsertMeeting(meetingFixture('200'), NOW);
    store.saveTranscript('200', ENTRIES, { hash: 'h', bytes: 42, status: 'skipped', skipReason: 'Only 7 words were spoken' }, NOW);
    expect(store.retryTranscript('200', NOW)).toBe(true);
    expect(store.meeting('200')).toMatchObject({ status: 'imported', skipReason: null });
    expect(store.transcript('200')?.entries).toEqual(ENTRIES);
    expect(store.analysisQueue(10)).toEqual(['200']);
  });

  it('counts items, flags meetings analyzed with older instructions, and filters items', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    db.prepare(`INSERT INTO meeting_extractions(id, recording_id, instructions_hash, transcript_hash, provider, model, summary_json, created_at)
      VALUES ('e1','100','old','h','openai','gpt-6-astra','{"headline":"Export pain","overview":"o","direction":["d"]}',?)`).run(NOW);
    insertItem('i1', '100');
    insertItem('i2', '100', { kind: 'pain_point', speaker_role: 'client', status: 'open' });
    insertItem('i3', '100', { status: 'done' });
    const [row] = store.list({ instructionsHash: 'new' });
    expect(row).toMatchObject({ headline: 'Export pain', analyzedAt: NOW, staleInstructions: true, counts: { commitment: 2, pain_point: 1, suggestion: 0, decision: 0 } });
    expect(store.list({ instructionsHash: 'old' })[0]?.staleInstructions).toBe(false);
    expect(store.items({ kinds: ['commitment'], statuses: ['open'] }).map(i => i.id)).toEqual(['i1']);
    expect(store.items({ projectId: 'p1' })).toHaveLength(3);
    expect(store.item('i2')).toMatchObject({ kind: 'pain_point', projectName: 'Acme', meetingTitle: 'Meeting 100', meetingUrl: 'https://fathom.video/calls/100' });
    expect(store.detail('100')).toMatchObject({ summary: { headline: 'Export pain', direction: ['d'] }, model: 'gpt-6-astra' });
  });

  it('maps only meeting Inbox rows back to their item, and Inbox actions skip other rows', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    insertItem('i1', '100');
    const row = db.prepare(`INSERT INTO inbox_items(id, project_id, kind, title, detail, evidence_json, dedupe_key, created_at, subject_key, fingerprint, active)
      VALUES (?, 'p1', ?, 't', 'd', '[]', ?, ?, ?, 'f', 1)`);
    row.run('meeting-row', 'meeting-promise', 'k1', NOW, JSON.stringify(['meeting', 'i1']));
    row.run('task-row', 'agent-question', 'k2', NOW, JSON.stringify(['ezboss-plan', 'i1']));
    expect(store.meetingItemForInbox('meeting-row')).toBe('i1');
    expect(store.meetingItemForInbox('task-row')).toBeNull();
    expect(store.meetingItemForInbox('missing')).toBeNull();
    expect(applyInboxAction(store, 'task-row', 'handled', new Date(NOW))).toBe(false);
    expect(store.item('i1')?.status).toBe('open');
    expect(applyInboxAction(store, 'meeting-row', 'undo', new Date(NOW))).toBe(false);
    expect(applyInboxAction(store, 'meeting-row', 'tomorrow', new Date(NOW))).toBe(false);
    expect(applyInboxAction(store, 'meeting-row', 'handled', new Date(NOW))).toBe(true);
    expect(store.item('i1')).toMatchObject({ status: 'done', statusSource: 'user', statusNote: 'Changed from the Inbox', statusChangedAt: NOW });
  });

  it('withdraws a "Looks done?" that quotes a forgotten meeting, and keeps other suggestions', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    store.upsertMeeting(meetingFixture('200'), NOW);
    store.upsertMeeting(meetingFixture('300'), NOW);
    insertItem('i1', '100', { quote: 'first promise quote' });
    insertItem('i2', '100', { quote: 'second promise quote' });
    store.suggestStatus('i1', { status: 'done', source: 'meeting', evidence: ['meeting:200'], note: 'Sounds done in "Meeting 200": "QUOTE FROM 200"' }, NOW);
    store.suggestStatus('i2', { status: 'done', source: 'meeting', evidence: ['meeting:300'], note: 'Sounds done in "Meeting 300"' }, NOW);
    store.forget('200', NOW);
    expect(store.item('i1')).toMatchObject({ status: 'open', statusNote: null, suggestedStatus: null });
    expect(JSON.stringify(db.prepare('SELECT * FROM meeting_items').all())).not.toContain('QUOTE FROM 200');
    expect(store.item('i2')).toMatchObject({ status: 'looks_done', suggestedStatus: 'done' });
  });

  it('forgets a meeting completely, including Inbox rows, and does not re-import it', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    store.saveTranscript('100', ENTRIES, { hash: 'h1', bytes: 42, status: 'imported', skipReason: null }, NOW);
    insertItem('i1', '100');
    db.prepare(`INSERT INTO inbox_items(id, project_id, kind, title, detail, evidence_json, dedupe_key, created_at, subject_key, fingerprint, active)
      VALUES ('x','p1','meeting-promise','Send the API docs','quote','[]','k',?,?, 'f', 1)`).run(NOW, JSON.stringify(['meeting', 'i1']));
    expect(store.forget('100', NOW)).toBe(true);
    expect(store.forget('100', NOW)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.detail('100')).toBeNull();
    expect(store.transcript('100')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_items').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_items').get()).toMatchObject({ n: 0 });
    const raw = JSON.stringify(db.prepare('SELECT * FROM meetings').all());
    expect(raw).not.toContain('SECRET-TRANSCRIPT-TEXT');
    expect(raw).not.toContain('jane@acme.com');
    expect(store.upsertMeeting(meetingFixture('100'), NOW)).toBe('ignored');
  });

  it('deletes all imported meetings on disconnect', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    insertItem('i1', '100');
    store.deleteAllMeetings();
    expect(db.prepare('SELECT COUNT(*) AS n FROM meetings').get()).toMatchObject({ n: 0 });
    expect(store.upsertMeeting(meetingFixture('100'), NOW)).toBe('added');
  });

  it('keeps the last 50 sync runs', () => {
    const store = meetingStore(db);
    for (let i = 0; i < MAX_SYNC_RUNS + 5; i++) {
      store.recordRun({ trigger: 'schedule', outcome: 'ok', stats: { added: i }, error: null, startedAt: NOW, finishedAt: NOW });
    }
    const runs = store.runs();
    expect(runs).toHaveLength(MAX_SYNC_RUNS);
    expect(runs[0]?.stats).toEqual({ added: MAX_SYNC_RUNS + 4 });
  });

  it('saves one rule per pattern and moves it on re-save', () => {
    db.exec("INSERT INTO projects VALUES('p2','/work/beta','Beta','2026-01-01','2026-01-01')");
    const store = meetingStore(db);
    store.saveRule('domain', 'acme.com', 'p1', NOW);
    store.saveRule('domain', 'acme.com', 'p2', NOW);
    expect(store.rules()).toMatchObject([{ kind: 'domain', pattern: 'acme.com', projectId: 'p2', projectName: 'Beta' }]);
    expect(store.deleteRule(store.rules()[0]!.id)).toBe(true);
    expect(store.rules()).toEqual([]);
  });

  it('rolls back a failed write inside a transaction', () => {
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    expect(() => store.transaction(() => {
      store.setMeetingProject('100', 'p1', 'user', NOW);
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.meeting('100')?.projectId).toBeNull();
  });
});

describe('meeting digest for delivery planning', () => {
  it('lists only this project\'s open promises, open pain points and decisions, without quotes or names', async () => {
    const { meetingDigest } = await import('../src/meetings/digest.ts');
    const store = meetingStore(db);
    store.upsertMeeting(meetingFixture('100'), NOW);
    db.exec("INSERT INTO projects VALUES('p2','/work/beta','Beta','2026-01-01','2026-01-01')");
    insertItem('i1', '100', { quote: 'SECRET QUOTE one' });
    insertItem('i2', '100', { status: 'done', text: 'Closed promise' });
    insertItem('i3', '100', { kind: 'pain_point', speaker: 'Jane Client', speaker_role: 'client', text: 'Export times out', quote: 'SECRET QUOTE two' });
    insertItem('i4', '100', { kind: 'decision', text: 'Ship filter next', quote: 'SECRET QUOTE three' });
    insertItem('i5', '100', { project_id: 'p2', text: 'Other project promise' });
    const digest = meetingDigest(store, 'p1');
    expect(digest).toEqual({
      promises: [{ text: 'Send the API docs', due: null, promisedOn: '2026-09-28' }],
      painPoints: [{ text: 'Export times out', idea: null }],
      decisions: [{ text: 'Ship filter next', decidedOn: '2026-09-28' }],
    });
    const text = JSON.stringify(digest);
    expect(text).not.toContain('SECRET QUOTE');
    expect(text).not.toContain('Jane');
    expect(text).not.toContain('@');
  });
});
