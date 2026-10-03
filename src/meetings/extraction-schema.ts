import type { SpeakerRole, Turn } from './transcript.ts';
import type { FeatureIdea, ItemKind, MeetingSummary } from './types.ts';

/** The prompt asks for 30 words; the check leaves a little room so a real promise is not lost. */
export const MAX_QUOTE_WORDS_ACCEPTED = 40;
export const MAX_QUOTE_CHARS = 400;
export const MAX_ITEM_TEXT = 400;
export const MAX_LIST_ITEMS = 20;
/** A quote may sit up to this many turns from the turn the model named. */
export const TURN_TOLERANCE = 2;
const MIN_QUOTE_CHARS = 8;
const DAY_MS = 86_400_000;

export type ExtractedItem = {
  kind: ItemKind;
  text: string;
  quote: string;
  turn: number;
  at: number;
  speaker: string;
  role: SpeakerRole;
  project: string | null;
  duePhrase: string | null;
  dueDate: string | null;
  feature: FeatureIdea | null;
};

export type StatusUpdate = { commitment: string; status: 'done' | 'dropped'; quote: string; turn: number; at: number; speaker: string };

export type DropCounts = {
  invalid: number;
  quoteNotFound: number;
  wrongSpeaker: number;
  unknownHandle: number;
  badDate: number;
  tooLong: number;
  duplicate: number;
};

export type ParsedExtraction = { summary: MeetingSummary; items: ExtractedItem[]; statusUpdates: StatusUpdate[]; dropped: DropCounts };

export type VerifyContext = {
  turns: readonly Turn[];
  /** Array positions [start, end) the model saw; quotes must come from these turns. */
  range: { start: number; end: number };
  projectHandles: ReadonlySet<string>;
  promiseHandles: ReadonlySet<string>;
  /** YYYY-MM-DD of the meeting; due dates must fall within the following year. */
  meetingDate: string;
};

export type ParseResult = { ok: true; value: ParsedExtraction } | { ok: false; error: 'invalid_json' | 'invalid_shape' };

const TOP_KEYS = ['summary', 'my_commitments', 'client_suggestions', 'client_pain_points', 'decisions', 'status_updates'] as const;
const LISTS: readonly [typeof TOP_KEYS[number], ItemKind][] = [
  ['my_commitments', 'commitment'],
  ['client_suggestions', 'suggestion'],
  ['client_pain_points', 'pain_point'],
  ['decisions', 'decision'],
];
/** Who must have spoken each kind of item. */
const SPEAKERS: Record<ItemKind, readonly SpeakerRole[]> = {
  commitment: ['me'],
  suggestion: ['client'],
  pain_point: ['client'],
  decision: ['me', 'client', 'teammate'],
};

const emptyDrops = (): DropCounts => ({ invalid: 0, quoteNotFound: 0, wrongSpeaker: 0, unknownHandle: 0, badDate: 0, tooLong: 0, duplicate: 0 });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOnly = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => required.includes(k) || optional.includes(k));

/** Collapses whitespace and strips control characters; null when empty or over the limit. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean && clean.length <= max ? clean : null;
}

/** Display text only: trimmed to the limit instead of rejected. */
function clipped(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Case, punctuation and quote-style insensitive, so a faithful copy always matches. */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordsIn = (value: string): number => value.split(/\s+/).filter(Boolean).length;

function turnHandle(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^T(\d{1,6})$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function dueInRange(value: string, meetingDate: string): boolean {
  if (!validDay(value) || !validDay(meetingDate)) return false;
  const due = Date.parse(`${value}T00:00:00Z`);
  const start = Date.parse(`${meetingDate}T00:00:00Z`);
  return due >= start && due <= start + 365 * DAY_MS;
}

function parseFeature(value: unknown): FeatureIdea | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (!isObj(value) || !hasOnly(value, ['title', 'outcome', 'acceptance'])) return 'invalid';
  const title = text(value.title, 160);
  const outcome = text(value.outcome, 400);
  if (!title || !outcome || !Array.isArray(value.acceptance) || value.acceptance.length < 2 || value.acceptance.length > 6) return 'invalid';
  const acceptance: string[] = [];
  for (const check of value.acceptance) {
    const clean = text(check, 250);
    if (!clean) return 'invalid';
    acceptance.push(clean);
  }
  return { title, outcome, acceptance };
}

/**
 * Finds the quote in the named turn or a neighbour inside the range the model saw.
 * Returns the turn it was found in, preferring the named one.
 */
export function locateQuote(quote: string, named: number, ctx: VerifyContext): Turn | null {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  const inRange = (t: Turn | undefined): t is Turn => {
    if (!t) return false;
    const position = t.index - 1;
    return position >= ctx.range.start && position < ctx.range.end;
  };
  const order = [0];
  for (let d = 1; d <= TURN_TOLERANCE; d++) order.push(-d, d);
  for (const offset of order) {
    const turn = ctx.turns[named - 1 + offset];
    if (inRange(turn) && normalizeForMatch(turn.text).includes(needle)) return turn;
  }
  return null;
}

function parseSummary(value: unknown): MeetingSummary | null {
  if (!isObj(value) || !hasOnly(value, ['headline', 'overview', 'direction'])) return null;
  const headline = clipped(value.headline, 160);
  const overview = clipped(value.overview, 900) ?? '';
  if (!headline || !Array.isArray(value.direction)) return null;
  const direction = value.direction.slice(0, 8).map(d => clipped(d, 300)).filter((d): d is string => d !== null);
  return { headline, overview, direction };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Parses and checks one model answer. The shape must be exact; each item must
 * quote a real line from the right kind of speaker. Failing items are dropped
 * and counted, never repaired by guessing.
 */
export function parseExtraction(raw: string, ctx: VerifyContext): ParseResult {
  let body: unknown;
  try { body = JSON.parse(stripFences(raw)); } catch { return { ok: false, error: 'invalid_json' }; }
  if (!isObj(body) || !hasOnly(body, TOP_KEYS)) return { ok: false, error: 'invalid_shape' };
  if (TOP_KEYS.slice(1).some(k => !Array.isArray(body[k]) || (body[k] as unknown[]).length > MAX_LIST_ITEMS)) return { ok: false, error: 'invalid_shape' };
  const summary = parseSummary(body.summary);
  if (!summary) return { ok: false, error: 'invalid_shape' };

  const dropped = emptyDrops();
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();

  for (const [key, kind] of LISTS) {
    for (const raw of body[key] as unknown[]) {
      const optional = ['project', ...(kind === 'pain_point' ? ['feature_idea'] : kind === 'commitment' ? ['due_phrase', 'due_date'] : [])];
      if (!isObj(raw) || !hasOnly(raw, ['text', 'quote', 'turn'], optional)) { dropped.invalid++; continue; }
      const itemText = text(raw.text, MAX_ITEM_TEXT);
      const quote = text(raw.quote, 2000);
      const turn = turnHandle(raw.turn);
      if (!itemText || !quote || turn === null) { dropped.invalid++; continue; }
      if (quote.length > MAX_QUOTE_CHARS || wordsIn(quote) > MAX_QUOTE_WORDS_ACCEPTED) { dropped.tooLong++; continue; }
      const found = locateQuote(quote, turn, ctx);
      if (!found) { dropped.quoteNotFound++; continue; }
      if (!SPEAKERS[kind].includes(found.role)) { dropped.wrongSpeaker++; continue; }
      const key2 = `${kind}\u0000${normalizeForMatch(quote)}`;
      if (seen.has(key2)) { dropped.duplicate++; continue; }

      let project: string | null = null;
      if (raw.project !== null && raw.project !== undefined) {
        if (typeof raw.project === 'string' && ctx.projectHandles.has(raw.project.trim())) project = raw.project.trim();
        else dropped.unknownHandle++;
      }
      let duePhrase: string | null = null;
      let dueDate: string | null = null;
      if (kind === 'commitment') {
        if (raw.due_phrase !== null && raw.due_phrase !== undefined) {
          duePhrase = text(raw.due_phrase, 80);
          if (!duePhrase) { dropped.invalid++; continue; }
        }
        if (raw.due_date !== null && raw.due_date !== undefined) {
          if (typeof raw.due_date === 'string' && dueInRange(raw.due_date.trim(), ctx.meetingDate)) dueDate = raw.due_date.trim();
          else dropped.badDate++;
        }
      }
      let feature: FeatureIdea | null = null;
      if (kind === 'pain_point') {
        const parsed = parseFeature(raw.feature_idea);
        if (parsed === 'invalid') dropped.invalid++;
        else feature = parsed;
      }
      seen.add(key2);
      items.push({ kind, text: itemText, quote, turn: found.index, at: found.at, speaker: found.speaker, role: found.role, project, duePhrase, dueDate, feature });
    }
  }

  const statusUpdates: StatusUpdate[] = [];
  const updated = new Set<string>();
  for (const raw of body.status_updates as unknown[]) {
    if (!isObj(raw) || !hasOnly(raw, ['commitment', 'status', 'quote', 'turn'])) { dropped.invalid++; continue; }
    const handle = typeof raw.commitment === 'string' ? raw.commitment.trim() : '';
    const quote = text(raw.quote, 2000);
    const turn = turnHandle(raw.turn);
    if ((raw.status !== 'done' && raw.status !== 'dropped') || !quote || turn === null) { dropped.invalid++; continue; }
    if (!ctx.promiseHandles.has(handle)) { dropped.unknownHandle++; continue; }
    if (quote.length > MAX_QUOTE_CHARS || wordsIn(quote) > MAX_QUOTE_WORDS_ACCEPTED) { dropped.tooLong++; continue; }
    const found = locateQuote(quote, turn, ctx);
    if (!found) { dropped.quoteNotFound++; continue; }
    if (updated.has(handle)) { dropped.duplicate++; continue; }
    updated.add(handle);
    statusUpdates.push({ commitment: handle, status: raw.status, quote, turn: found.index, at: found.at, speaker: found.speaker });
  }

  return { ok: true, value: { summary, items, statusUpdates, dropped } };
}
