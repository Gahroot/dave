import { describe, expect, it } from 'vitest';
import { locateQuote, normalizeForMatch, parseExtraction, type VerifyContext } from '../src/meetings/extraction-schema.ts';
import type { Turn } from '../src/meetings/transcript.ts';

const turn = (index: number, role: Turn['role'], speaker: string, text: string): Turn =>
  ({ index, at: index * 10, time: '00:00:00', speaker, email: null, role, text });
const TURNS: Turn[] = [
  turn(1, 'client', 'Jane', 'Hi! How was the weekend? Mine was lovely.'),
  turn(2, 'client', 'Jane', 'The CSV export keeps timing out when we pick a full year.'),
  turn(3, 'me', 'Dave', "Got it. I'll send the API docs by Friday, and I’ll look at the export timeout."),
  turn(4, 'teammate', 'Tom', 'I can pair on the export query tomorrow.'),
  turn(5, 'client', 'Jane', 'Could you add a filter for archived invoices?'),
  turn(6, 'me', 'Dave', 'Agreed, we ship the archive filter in the next release.'),
  turn(7, 'client', 'Jane', 'Thanks for sending the staging link yesterday, it works.'),
  turn(8, 'unknown', 'Speaker 3', 'We will also need SSO next quarter, promise.'),
];
const CTX: VerifyContext = {
  turns: TURNS,
  range: { start: 0, end: TURNS.length },
  projectHandles: new Set(['P1', 'P2']),
  promiseHandles: new Set(['C1']),
  meetingDate: '2026-09-28',
};
const EMPTY = { summary: { headline: 'Export timeouts', overview: 'Client reports slow exports.', direction: ['Fix export'] }, my_commitments: [], client_suggestions: [], client_pain_points: [], decisions: [], status_updates: [] };
const run = (patch: Record<string, unknown>, ctx: VerifyContext = CTX) => parseExtraction(JSON.stringify({ ...EMPTY, ...patch }), ctx);
const promise = (over: Record<string, unknown> = {}) => ({ text: 'Send the API docs', due_phrase: 'by Friday', due_date: '2026-10-02', project: 'P1', quote: "I'll send the API docs by Friday", turn: 'T3', ...over });

describe('extraction output shape', () => {
  it.each([
    ['not JSON', 'nope', 'invalid_json'],
    ['an array', '[]', 'invalid_shape'],
    ['an extra top-level key', JSON.stringify({ ...EMPTY, action_items: [] }), 'invalid_shape'],
    ['a missing list', JSON.stringify({ ...EMPTY, decisions: undefined }), 'invalid_shape'],
    ['a list that is not an array', JSON.stringify({ ...EMPTY, decisions: {} }), 'invalid_shape'],
    ['too many items', JSON.stringify({ ...EMPTY, decisions: Array.from({ length: 21 }, () => ({})) }), 'invalid_shape'],
    ['a summary without a headline', JSON.stringify({ ...EMPTY, summary: { headline: '', overview: '', direction: [] } }), 'invalid_shape'],
  ])('rejects %s', (_, raw, error) => {
    expect(parseExtraction(raw, CTX)).toEqual({ ok: false, error });
  });

  it('accepts a fenced answer and clips an over-long summary', () => {
    const raw = '```json\n' + JSON.stringify({ ...EMPTY, summary: { headline: 'h'.repeat(200), overview: 'o', direction: Array.from({ length: 10 }, (_, i) => `d${i}`) } }) + '\n```';
    const result = parseExtraction(raw, CTX);
    expect(result.ok && result.value.summary.headline.length).toBe(160);
    expect(result.ok && result.value.summary.direction).toHaveLength(8);
  });
});

describe('item checks', () => {
  it('keeps a verified promise with its real speaker, time and resolved date', () => {
    const result = run({ my_commitments: [promise()] });
    expect(result).toEqual({ ok: true, value: expect.objectContaining({
      items: [{ kind: 'commitment', text: 'Send the API docs', quote: "I'll send the API docs by Friday", turn: 3, at: 30, speaker: 'Dave', role: 'me', project: 'P1', duePhrase: 'by Friday', dueDate: '2026-10-02', feature: null }],
    }) });
  });

  it.each([
    ['an invented quote', { my_commitments: [promise({ quote: "I'll deliver the whole redesign by Monday" })] }, 'quoteNotFound'],
    ['a quote from a turn far away', { my_commitments: [promise({ turn: 'T8' })] }, 'quoteNotFound'],
    ['a turn outside the transcript', { my_commitments: [promise({ turn: 'T99' })] }, 'quoteNotFound'],
    ['a trivially short quote', { my_commitments: [promise({ quote: 'Got it' })] }, 'quoteNotFound'],
    ['a promise the client made', { my_commitments: [promise({ quote: 'Could you add a filter for archived invoices', turn: 'T5' })] }, 'wrongSpeaker'],
    ['a promise a teammate made', { my_commitments: [promise({ quote: 'I can pair on the export query tomorrow', turn: 'T4' })] }, 'wrongSpeaker'],
    ['a promise by an unknown speaker', { my_commitments: [promise({ quote: 'We will also need SSO next quarter', turn: 'T8' })] }, 'wrongSpeaker'],
    ['a client ask I said', { client_suggestions: [{ text: 'x', project: null, quote: "I'll send the API docs by Friday", turn: 'T3' }] }, 'wrongSpeaker'],
    ['a quote over 40 words', { my_commitments: [promise({ quote: Array.from({ length: 41 }, () => 'word').join(' ') })] }, 'tooLong'],
    ['an extra item key', { my_commitments: [promise({ owner: 'Dave' })] }, 'invalid'],
    ['a non-string text', { my_commitments: [promise({ text: 5 })] }, 'invalid'],
    ['a bad turn handle', { my_commitments: [promise({ turn: 3 })] }, 'invalid'],
  ])('drops %s', (_, patch, reason) => {
    const result = run(patch);
    expect(result.ok && result.value.items).toEqual([]);
    expect(result.ok && result.value.dropped[reason as 'invalid']).toBe(1);
  });

  it('finds a quote one turn away and uses the turn it is really in', () => {
    const result = run({ my_commitments: [promise({ turn: 'T2' })] });
    expect(result.ok && result.value.items[0]).toMatchObject({ turn: 3, speaker: 'Dave' });
  });

  it('matches regardless of case, punctuation and curly quotes', () => {
    const result = run({ my_commitments: [promise({ quote: "i'll LOOK at the export timeout" })] });
    expect(result.ok && result.value.items).toHaveLength(1);
    expect(normalizeForMatch('I’ll — look!')).toBe(normalizeForMatch("i'll look"));
  });

  it('only accepts quotes from the part of the transcript the model saw', () => {
    const part: VerifyContext = { ...CTX, range: { start: 4, end: 8 } };
    expect(locateQuote("I'll send the API docs by Friday", 3, part)).toBeNull();
    expect(locateQuote('ship the archive filter', 6, part)?.index).toBe(6);
  });

  it('keeps the item but drops an unknown project or an out-of-range date', () => {
    const result = run({ my_commitments: [promise({ project: 'P9', due_date: '2026-09-01' })] });
    expect(result.ok && result.value.items[0]).toMatchObject({ project: null, dueDate: null, duePhrase: 'by Friday' });
    expect(result.ok && result.value.dropped).toMatchObject({ unknownHandle: 1, badDate: 1 });
    for (const date of ['2027-09-29', '2026-02-30', 'Friday']) {
      const r = run({ my_commitments: [promise({ due_date: date })] });
      expect(r.ok && r.value.items[0]?.dueDate).toBeNull();
    }
    const edge = run({ my_commitments: [promise({ due_date: '2027-09-28' })] });
    expect(edge.ok && edge.value.items[0]?.dueDate).toBe('2027-09-28');
  });

  it('checks feature ideas on pain points and drops duplicates', () => {
    const pain = { text: 'Export times out for a full year', project: 'P1', quote: 'The CSV export keeps timing out', turn: 'T2' };
    const good = { title: 'Background export', outcome: 'Full-year exports finish', acceptance: ['A full year exports', 'The user gets a link'] };
    const result = run({ client_pain_points: [{ ...pain, feature_idea: good }, { ...pain, text: 'dup', feature_idea: null }] });
    expect(result.ok && result.value.items).toEqual([expect.objectContaining({ kind: 'pain_point', feature: good, role: 'client' })]);
    expect(result.ok && result.value.dropped.duplicate).toBe(1);
    const bad = run({ client_pain_points: [{ ...pain, feature_idea: { ...good, acceptance: ['only one'] } }] });
    expect(bad.ok && bad.value.items[0]?.feature).toBeNull();
    expect(bad.ok && bad.value.dropped.invalid).toBe(1);
  });

  it('accepts decisions from anyone who spoke for the project', () => {
    const result = run({ decisions: [{ text: 'Archive filter ships next release', project: 'P2', quote: 'we ship the archive filter in the next release', turn: 'T6' }] });
    expect(result.ok && result.value.items[0]).toMatchObject({ kind: 'decision', project: 'P2', role: 'me' });
  });

  it('verifies status updates against known promise handles', () => {
    const update = { commitment: 'C1', status: 'done', quote: 'Thanks for sending the staging link yesterday', turn: 'T7' };
    const result = run({ status_updates: [update, { ...update, commitment: 'C7' }, { ...update, quote: 'The staging link never arrived' }, { ...update, status: 'closed' }] });
    expect(result.ok && result.value.statusUpdates).toEqual([{ commitment: 'C1', status: 'done', quote: update.quote, turn: 7, at: 70, speaker: 'Jane' }]);
    expect(result.ok && result.value.dropped).toMatchObject({ unknownHandle: 1, quoteNotFound: 1, invalid: 1 });
  });
});
