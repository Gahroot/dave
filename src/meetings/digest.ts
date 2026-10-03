import type { MeetingsDigest } from '../model/delivery-context.ts';
import type { MeetingStore } from './store.ts';

const MAX_EACH = 20;

/**
 * A project's meeting digest for delivery planning: open promises, open client
 * pain points with their ideas, and decisions. DAVE's own analysis only; no
 * transcripts, quotes, names or emails.
 */
export function meetingDigest(store: MeetingStore, projectId: string): MeetingsDigest {
  const day = (iso: string): string => iso.slice(0, 10);
  const promises = store.items({ projectId, kinds: ['commitment'], statuses: ['open', 'looks_done'], limit: MAX_EACH })
    .map(i => ({ text: i.text, due: i.dueDate, promisedOn: day(i.meetingAt) }));
  const painPoints = store.items({ projectId, kinds: ['pain_point'], statuses: ['open', 'planned'], limit: MAX_EACH })
    .map(i => ({ text: i.text, idea: i.feature ? `${i.feature.title}: ${i.feature.outcome}` : null }));
  const decisions = store.items({ projectId, kinds: ['decision'], limit: MAX_EACH })
    .map(i => ({ text: i.text, decidedOn: day(i.meetingAt) }));
  return { promises, painPoints, decisions };
}
