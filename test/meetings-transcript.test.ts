import { describe, expect, it } from 'vitest';
import type { FathomAttendee, FathomTranscriptEntry } from '../src/meetings/fathom-client.ts';
import {
  assignRole, formatSeconds, normalizeTranscript, secondsOf, splitTurns, transcriptHash, turnLine, wordCount,
  type Identity, type Turn,
} from '../src/meetings/transcript.ts';

const ME: Identity = { email: 'dave@studio.dev', aliases: ['Dave O.', 'dave'] };
const person = (p: Partial<FathomAttendee>): FathomAttendee =>
  ({ name: null, email: null, domain: null, external: false, speakerName: null, ...p });
const ATTENDEES = [
  person({ name: 'Dave Owner', email: 'dave@studio.dev', speakerName: 'Dave Owner' }),
  person({ name: 'Jane Client', email: 'jane@acme.com', external: true }),
  person({ name: 'Tom Team', email: 'tom@studio.dev', speakerName: 'Tommy' }),
];

describe('speaker roles', () => {
  it.each([
    ['my email', { speaker: 'Whoever', email: 'DAVE@studio.dev' }, ATTENDEES, 'me'],
    ['my calendar name', { speaker: 'Dave Owner', email: null }, ATTENDEES, 'me'],
    ['an alias', { speaker: '  dave  o. ', email: null }, ATTENDEES, 'me'],
    ['external invitee by email', { speaker: 'J', email: 'jane@acme.com' }, ATTENDEES, 'client'],
    ['internal invitee by email', { speaker: 'T', email: 'tom@studio.dev' }, ATTENDEES, 'teammate'],
    ['external invitee by name', { speaker: 'Jane Client', email: null }, ATTENDEES, 'client'],
    ['internal invitee by speaker name', { speaker: 'Tommy', email: null }, ATTENDEES, 'teammate'],
    ['stranger in a mixed meeting', { speaker: 'Speaker 3', email: null }, ATTENDEES, 'unknown'],
    ['stranger when everyone else is external', { speaker: 'Speaker 2', email: null }, [ATTENDEES[0]!, ATTENDEES[1]!], 'client'],
    ['stranger with no attendee data', { speaker: 'Speaker 2', email: null }, [], 'unknown'],
    ['email wins over a matching alias', { speaker: 'dave', email: 'tom@studio.dev' }, ATTENDEES, 'teammate'],
    ['ambiguous name across roles', { speaker: 'Sam', email: null }, [person({ name: 'Sam', external: true, email: 'sam@acme.com' }), person({ name: 'Sam', email: 'sam@studio.dev' })], 'unknown'],
  ] as const)('%s', (_, entry, attendees, role) => {
    expect(assignRole(entry, attendees, ME)).toBe(role);
  });

  it('never calls anyone "me" when no identity is configured', () => {
    expect(assignRole({ speaker: 'Dave Owner', email: 'dave@studio.dev' }, ATTENDEES, { email: '', aliases: [] })).toBe('teammate');
  });
});

describe('transcript normalization', () => {
  const entries: FathomTranscriptEntry[] = [
    { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:05:32', text: 'The export keeps timing out.' },
    { speaker: 'Dave Owner', email: null, timestamp: '00:05:40', text: "I'll send the API docs by Friday." },
    { speaker: '[Tommy]', email: null, timestamp: '01:02:03', text: 'Sounds good.' },
    { speaker: 'X', email: null, timestamp: '00:99:00', text: 'bad time is skipped' },
  ];

  it('numbers turns, converts times and labels roles', () => {
    expect(normalizeTranscript(entries, ATTENDEES, ME)).toEqual([
      { index: 1, at: 332, time: '00:05:32', speaker: 'Jane Client', email: 'jane@acme.com', role: 'client', text: 'The export keeps timing out.' },
      { index: 2, at: 340, time: '00:05:40', speaker: 'Dave Owner', email: null, role: 'me', text: "I'll send the API docs by Friday." },
      { index: 3, at: 3723, time: '01:02:03', speaker: 'Tommy', email: null, role: 'teammate', text: 'Sounds good.' },
    ]);
  });

  it('converts times both ways', () => {
    expect(secondsOf('10:00:01')).toBe(36001);
    expect(secondsOf('00:60:00')).toBeNull();
    expect(secondsOf('1:00:00')).toBeNull();
    expect(formatSeconds(3723)).toBe('01:02:03');
  });

  it('hashes content, not object key order', () => {
    const reordered = entries.map(e => ({ text: e.text, timestamp: e.timestamp, email: e.email, speaker: e.speaker }));
    expect(transcriptHash(reordered)).toBe(transcriptHash(entries));
    expect(transcriptHash([{ ...entries[0]!, text: 'changed' }, ...entries.slice(1)])).not.toBe(transcriptHash(entries));
    expect(wordCount(entries)).toBe(18);
  });
});

describe('splitting', () => {
  const turns = (n: number, text = 'x'.repeat(80)): Turn[] => Array.from({ length: n }, (_, i) => ({
    index: i + 1, at: i, time: formatSeconds(i), speaker: 'S', email: null, role: 'client', text,
  }));

  it('keeps a short transcript in one piece', () => {
    const t = turns(10);
    expect(splitTurns(t, 200_000)).toEqual([{ start: 0, end: 10, bytes: t.reduce((s, x) => s + Buffer.byteLength(turnLine(x)) + 1, 0) }]);
  });

  it('splits by turns under the byte limit with a three-turn overlap', () => {
    const t = turns(100);
    const sizes = t.map(x => Buffer.byteLength(turnLine(x)) + 1);
    const limit = 2000;
    const pieces = splitTurns(t, limit, 3);
    expect(pieces.length).toBeGreaterThan(3);
    for (const [i, p] of pieces.entries()) {
      const bytes = sizes.slice(p.start, p.end).reduce((a, b) => a + b, 0);
      expect(p.bytes).toBe(bytes);
      expect(bytes).toBeLessThanOrEqual(limit);
      // Greedy: one more turn would not have fit.
      if (p.end < t.length) expect(bytes + sizes[p.end]!).toBeGreaterThan(limit);
      if (i > 0) expect(p.start).toBe(pieces[i - 1]!.end - 3);
    }
    expect(pieces[0]!.start).toBe(0);
    expect(pieces.at(-1)?.end).toBe(100);
  });

  it('always makes progress, even past an oversized turn', () => {
    const t = [...turns(2), ...turns(1, 'y'.repeat(5000)), ...turns(2)];
    const pieces = splitTurns(t, 500, 3);
    expect(pieces.at(-1)?.end).toBe(5);
    expect(pieces.length).toBeLessThan(10);
    expect(splitTurns([], 500)).toEqual([]);
  });
});
