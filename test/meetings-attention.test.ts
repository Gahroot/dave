import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_DAYS, meetingCandidates, promiseState, URGENCY } from '../src/meetings/attention.ts';
import type { MeetingItem } from '../src/meetings/types.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const item = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  id: 'mi-1', recordingId: '100', kind: 'commitment', text: 'Send the API docs', quote: "I'll send the API docs by Friday",
  atSeconds: 95, speaker: 'Dave Owner', speakerRole: 'me', projectId: 'p1', projectName: 'Acme', projectSource: 'model',
  duePhrase: null, dueDate: null, feature: null, status: 'open', suggestedStatus: null, statusSource: 'model', statusNote: null, statusChangedAt: null,
  edited: false, agentRunId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  meetingTitle: 'Acme weekly', meetingAt: '2026-09-28T16:00:00.000Z', meetingUrl: 'https://fathom.video/calls/100',
  ...over,
});
const projects = new Map([['p1', { name: 'Acme', lastTechnicalActivityAt: null as string | null }]]);

describe('promise state', () => {
  it.each([
    ['due yesterday', { dueDate: '2026-09-29' }, null, 'overdue'],
    ['due today', { dueDate: '2026-09-30' }, null, 'due_soon'],
    ['due in two days', { dueDate: '2026-10-02' }, null, 'due_soon'],
    ['due in three days', { dueDate: '2026-10-03' }, null, 'open'],
    ['a week old with no work since', { meetingAt: '2026-09-23T12:00:00.000Z' }, '2026-09-20T00:00:00.000Z', 'not_followed_up'],
    ['a week old with no activity at all', { meetingAt: '2026-09-23T12:00:00.000Z' }, null, 'not_followed_up'],
    ['a week old with work since', { meetingAt: '2026-09-23T12:00:00.000Z' }, '2026-09-25T00:00:00.000Z', 'open'],
    ['six days old with no work', { meetingAt: '2026-09-24T13:00:00.000Z' }, null, 'open'],
    ['overdue beats not followed up', { meetingAt: '2026-09-01T00:00:00.000Z', dueDate: '2026-09-05' }, null, 'overdue'],
  ] as const)('%s', (_, over, lastWork, state) => {
    expect(promiseState(item(over), { lastTechnicalActivityAt: lastWork }, NOW)).toBe(state);
  });

  it('uses the documented follow-up window', () => {
    expect(FOLLOW_UP_DAYS).toBe(7);
  });
});

describe('meeting attention candidates', () => {
  it('turns an open promise into a quoted Inbox item for its project', () => {
    const [c] = meetingCandidates([item({ dueDate: '2026-10-01' })], projects, NOW);
    expect(c).toMatchObject({
      projectId: 'p1',
      subjectKey: JSON.stringify(['meeting', 'mi-1']),
      kind: 'meeting-promise',
      title: 'Acme: Send the API docs',
      urgency: URGENCY.dueSoon,
      evidence: [{ kind: 'meeting', path: 'https://fathom.video/calls/100', detail: `Dave Owner at 1:35: "I'll send the API docs by Friday"`, observedAt: '2026-09-28T16:00:00.000Z' }],
    });
    expect(c?.detail).toContain('Acme weekly on Sep 28');
    expect(c?.detail).toContain('due Oct 1');
  });

  it.each([
    [{ dueDate: '2026-09-01', meetingAt: '2026-08-25T00:00:00.000Z' }, URGENCY.overdue],
    [{ dueDate: '2026-10-01' }, URGENCY.dueSoon],
    [{ meetingAt: '2026-09-20T00:00:00.000Z' }, URGENCY.notFollowedUp],
    [{}, URGENCY.newPromise],
  ])('rates %j at %i', (over, urgency) => {
    expect(meetingCandidates([item(over)], projects, NOW)[0]?.urgency).toBe(urgency);
  });

  it('ranks urgencies between agent questions (100) and inspections (50)', () => {
    expect([URGENCY.overdue, URGENCY.dueSoon, URGENCY.notFollowedUp, URGENCY.newPromise]).toEqual([90, 80, 70, 60]);
    expect(URGENCY.clientIdea).toBe(45);
  });

  it('turns a pain point with a feature idea into a client idea, and skips one without', () => {
    const feature = { title: 'Background export', outcome: 'Full-year exports finish', acceptance: ['a', 'b'] };
    const candidates = meetingCandidates([
      item({ id: 'mi-2', kind: 'pain_point', speaker: 'Jane Client', speakerRole: 'client', quote: 'The export keeps timing out', feature }),
      item({ id: 'mi-3', kind: 'pain_point', feature: null }),
    ], projects, NOW);
    expect(candidates).toEqual([expect.objectContaining({ kind: 'client-idea', title: 'Acme: Background export', urgency: URGENCY.clientIdea, detail: 'Jane Client said "The export keeps timing out". Idea: Full-year exports finish' })]);
  });

  it('skips items without a project, on hidden or unknown projects, and anything not open', () => {
    const candidates = meetingCandidates([
      item({ id: 'a', projectId: null }),
      item({ id: 'b', projectId: 'hidden-project' }),
      item({ id: 'c', status: 'looks_done' }),
      item({ id: 'd', status: 'done' }),
      item({ id: 'e', status: 'planned' }),
      item({ id: 'f', kind: 'suggestion' }),
      item({ id: 'g', kind: 'decision' }),
    ], projects, NOW);
    expect(candidates).toEqual([]);
  });

  it('asks again when a promise changes state, but not on every refresh', () => {
    const fresh = meetingCandidates([item({ dueDate: '2026-10-05' })], projects, NOW)[0];
    const again = meetingCandidates([item({ dueDate: '2026-10-05' })], projects, NOW)[0];
    const later = meetingCandidates([item({ dueDate: '2026-10-05' })], projects, new Date('2026-10-04T09:00:00.000Z'))[0];
    const reworded = meetingCandidates([item({ dueDate: '2026-10-05', text: 'Send the REST docs' })], projects, NOW)[0];
    expect(again?.fingerprint).toBe(fresh?.fingerprint);
    expect(later?.fingerprint).not.toBe(fresh?.fingerprint);
    expect(reworded?.fingerprint).not.toBe(fresh?.fingerprint);
    expect(later?.subjectKey).toBe(fresh?.subjectKey);
  });
});
