import { createHash } from 'node:crypto';
import type { FathomAttendee, FathomTranscriptEntry } from './fathom-client.ts';

export type SpeakerRole = 'me' | 'client' | 'teammate' | 'unknown';

/** One spoken turn, numbered so the model can point at it and DAVE can check it. */
export type Turn = {
  index: number;
  at: number;
  time: string;
  speaker: string;
  email: string | null;
  role: SpeakerRole;
  text: string;
};

/** Who "you" are in a meeting: your Fathom email plus the names you appear under. */
export type Identity = { email: string; aliases: readonly string[] };

export type Piece = { start: number; end: number; bytes: number };

/** Transcript pieces stay below this so the whole request fits the 240 KB meetings budget. */
export const MAX_PIECE_BYTES = 200_000;
export const PIECE_OVERLAP_TURNS = 3;

const normName = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function secondsOf(timestamp: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timestamp);
  if (!match) return null;
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}

export function formatSeconds(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(safe % 60)}`;
}

/**
 * Labels a speaker from Fathom's attendee data. Email beats name; a name only
 * counts when it is unambiguous. When everyone invited besides you is external,
 * an unmatched speaker is treated as the client.
 */
export function assignRole(
  entry: Pick<FathomTranscriptEntry, 'speaker' | 'email'>,
  attendees: readonly FathomAttendee[],
  identity: Identity,
): SpeakerRole {
  const myEmail = identity.email.trim().toLowerCase();
  const email = entry.email?.toLowerCase() ?? null;
  if (email && myEmail && email === myEmail) return 'me';
  const invited = email ? attendees.find(a => a.email === email) : undefined;
  if (invited) return invited.external ? 'client' : 'teammate';

  const name = normName(entry.speaker);
  const mine = new Set(identity.aliases.map(normName).filter(Boolean));
  for (const a of attendees) {
    if (!myEmail || a.email !== myEmail) continue;
    if (a.name) mine.add(normName(a.name));
    if (a.speakerName) mine.add(normName(a.speakerName));
  }
  if (name && mine.has(name)) return 'me';

  const others = attendees.filter(a => !myEmail || a.email !== myEmail);
  const byName = others.filter(a =>
    (a.speakerName !== null && normName(a.speakerName) === name) || (a.name !== null && normName(a.name) === name));
  const roles = new Set(byName.map(a => (a.external ? 'client' : 'teammate') as SpeakerRole));
  if (roles.size === 1) return [...roles][0] ?? 'unknown';
  if (roles.size === 0 && others.length > 0 && others.every(a => a.external)) return 'client';
  return 'unknown';
}

export function normalizeTranscript(
  entries: readonly FathomTranscriptEntry[],
  attendees: readonly FathomAttendee[],
  identity: Identity,
): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const at = secondsOf(entry.timestamp);
    if (at === null || !entry.text.trim()) continue;
    // Brackets are reserved for turn labels in the prompt.
    const speaker = entry.speaker.replace(/[[\]]/g, '').trim() || 'Unknown speaker';
    turns.push({
      index: turns.length + 1,
      at,
      time: entry.timestamp,
      speaker,
      email: entry.email,
      role: assignRole({ speaker, email: entry.email }, attendees, identity),
      text: entry.text,
    });
  }
  return turns;
}

/** Stable across storage round trips: hashes values in a fixed order, not object keys. */
export function transcriptHash(entries: readonly FathomTranscriptEntry[]): string {
  const canonical = JSON.stringify(entries.map(e => [e.timestamp, e.speaker, e.email, e.text]));
  return createHash('sha256').update(canonical).digest('hex');
}

export function transcriptBytes(entries: readonly FathomTranscriptEntry[]): number {
  return entries.reduce((sum, e) => sum + Buffer.byteLength(e.text) + Buffer.byteLength(e.speaker) + 16, 0);
}

export function wordCount(entries: readonly Pick<FathomTranscriptEntry, 'text'>[]): number {
  return entries.reduce((sum, e) => sum + (e.text.match(/\S+/g)?.length ?? 0), 0);
}

/** The exact line format sent to the model, so piece sizes measure what is sent. */
export function turnLine(turn: Turn): string {
  return `[T${turn.index}] ${turn.time} ${turn.speaker} (${turn.role}): ${turn.text}`;
}

/**
 * Splits turns into pieces of at most `maxBytes` of rendered lines, repeating
 * `overlap` turns at each boundary. Always makes progress, even when a single
 * turn is larger than the limit.
 */
export function splitTurns(turns: readonly Turn[], maxBytes: number = MAX_PIECE_BYTES, overlap: number = PIECE_OVERLAP_TURNS): Piece[] {
  if (turns.length === 0) return [];
  const sizes = turns.map(t => Buffer.byteLength(turnLine(t)) + 1);
  const pieces: Piece[] = [];
  let start = 0;
  for (;;) {
    let end = start;
    let bytes = 0;
    while (end < turns.length && (end === start || bytes + (sizes[end] ?? 0) <= maxBytes)) {
      bytes += sizes[end] ?? 0;
      end++;
    }
    pieces.push({ start, end, bytes });
    if (end >= turns.length) return pieces;
    start = Math.max(start + 1, end - overlap);
  }
}
