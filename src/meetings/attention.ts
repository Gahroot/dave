import { createHash } from 'node:crypto';
import { retainedTasks } from '../model/task-policy.ts';
import type { AttentionAction, AttentionCandidate, EvidenceRef, PortfolioProject } from '../shared/types.ts';
import type { MeetingStore } from './store.ts';
import type { MeetingItem } from './types.ts';

/** Urgency levels next to the existing ones: agent question 100, inspection 50. */
export const URGENCY = {
  overdue: 90,
  dueSoon: 80,
  notFollowedUp: 70,
  newPromise: 60,
  clientIdea: 45,
} as const;

/** A promise this old with no work on its project since the meeting is "not followed up". */
export const FOLLOW_UP_DAYS = 7;
export const DUE_SOON_DAYS = 2;
const DAY_MS = 86_400_000;

export type PromiseState = 'overdue' | 'due_soon' | 'not_followed_up' | 'open';

export type ProjectActivity = { lastTechnicalActivityAt: string | null };

/** Calendar days in UTC, so a promise due today is not overdue until tomorrow. */
function dayStart(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

/**
 * Where an open promise stands, from local facts only: its due date, its age and
 * whether any work happened on its project since the meeting.
 */
export function promiseState(item: Pick<MeetingItem, 'dueDate' | 'meetingAt'>, activity: ProjectActivity | null, now: Date): PromiseState {
  const today = dayStart(now.toISOString());
  if (item.dueDate) {
    const due = dayStart(item.dueDate);
    if (due < today) return 'overdue';
    if (due - today <= DUE_SOON_DAYS * DAY_MS) return 'due_soon';
  }
  const meetingAt = Date.parse(item.meetingAt);
  const old = Number.isFinite(meetingAt) && now.getTime() - meetingAt >= FOLLOW_UP_DAYS * DAY_MS;
  const lastWork = activity?.lastTechnicalActivityAt ? Date.parse(activity.lastTechnicalActivityAt) : Number.NaN;
  if (old && !(Number.isFinite(lastWork) && lastWork > meetingAt)) return 'not_followed_up';
  return 'open';
}

const URGENCY_OF: Record<PromiseState, number> = {
  overdue: URGENCY.overdue,
  due_soon: URGENCY.dueSoon,
  not_followed_up: URGENCY.notFollowedUp,
  open: URGENCY.newPromise,
};

function formatDay(iso: string): string {
  return new Date(dayStart(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function why(item: MeetingItem, state: PromiseState): string {
  const said = `You said "${item.quote}" in ${item.meetingTitle} on ${formatDay(item.meetingAt)}.`;
  switch (state) {
    case 'overdue': return `${said} It was due ${formatDay(item.dueDate ?? item.meetingAt)}.`;
    case 'due_soon': return `${said} It is due ${formatDay(item.dueDate ?? item.meetingAt)}.`;
    case 'not_followed_up': return `${said} No work on this project since that meeting.`;
    case 'open': return said;
  }
}

function evidenceOf(item: MeetingItem): EvidenceRef[] {
  return [{
    kind: 'meeting',
    path: item.meetingUrl,
    detail: `${item.speaker} at ${Math.floor(item.atSeconds / 60)}:${String(item.atSeconds % 60).padStart(2, '0')}: "${item.quote}"`,
    observedAt: item.meetingAt,
  }];
}

const fingerprint = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Open promises and feature ideas as Inbox candidates for visible projects.
 * The subject is the item; the fingerprint covers its text and due state, so a
 * promise that becomes overdue asks again even if an earlier state was handled.
 */
export function meetingCandidates(items: readonly MeetingItem[], projects: ReadonlyMap<string, Pick<PortfolioProject, 'name'> & ProjectActivity>, now: Date): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  for (const item of items) {
    if (!item.projectId || item.status !== 'open') continue;
    const project = projects.get(item.projectId);
    if (!project) continue;
    const subjectKey = JSON.stringify(['meeting', item.id]);
    if (item.kind === 'commitment') {
      const state = promiseState(item, project, now);
      out.push({
        projectId: item.projectId,
        subjectKey,
        fingerprint: fingerprint(['meeting-promise', item.id, item.text, item.dueDate, state]),
        kind: 'meeting-promise',
        title: `${project.name}: ${item.text}`,
        detail: why(item, state),
        evidence: evidenceOf(item),
        urgency: URGENCY_OF[state],
        nextStep: state === 'overdue' ? 'Deliver it, or tell the client when it will come' : 'Do it, or mark it done if it already happened',
      });
    } else if (item.kind === 'pain_point' && item.feature) {
      out.push({
        projectId: item.projectId,
        subjectKey,
        fingerprint: fingerprint(['client-idea', item.id, item.text, item.feature.title]),
        kind: 'client-idea',
        title: `${project.name}: ${item.feature.title}`,
        detail: `${item.speaker} said "${item.quote}". Idea: ${item.feature.outcome}`,
        evidence: evidenceOf(item),
        urgency: URGENCY.clientIdea,
        nextStep: 'Draft an agent assignment, or dismiss the idea',
      });
    }
  }
  return out;
}

/**
 * Last work on a project: commits, agent sessions and task updates, leaving out
 * EZ Coder's own task list like the rest of DAVE (the ezcoder-task-boundary rule).
 */
export function lastWorkAt(project: Pick<PortfolioProject, 'activity' | 'tasks'>): string | null {
  const taskTimes = retainedTasks(project.tasks).map(t => t.updatedAt).filter((v): v is string => !!v);
  return [project.activity.lastCommitAt, project.activity.lastAgentSessionAt, ...taskTimes]
    .filter((v): v is string => !!v).sort().at(-1) ?? null;
}

/** Candidates from the store, for visible projects in the portfolio being saved. */
export function meetingAttention(store: MeetingStore, visible: readonly PortfolioProject[], now: Date): AttentionCandidate[] {
  const projects = new Map(visible.filter(p => !p.override.hidden && p.exists)
    .map(p => [p.id, { name: p.name, lastTechnicalActivityAt: lastWorkAt(p) }]));
  const items = store.items({ kinds: ['commitment', 'pain_point'], statuses: ['open'] });
  return meetingCandidates(items, projects, now);
}

export type Reconcile = (candidates: AttentionCandidate[], observedProjects: string[], now: string) => void;

/**
 * Inbox actions on a meeting row update the promise or idea behind it:
 * Handled marks it done, Dismiss drops it, Undo reopens it. Snoozing changes
 * nothing. Returns whether an item changed.
 */
export function applyInboxAction(store: MeetingStore, inboxId: string, action: AttentionAction, now: Date): boolean {
  const itemId = store.meetingItemForInbox(inboxId);
  const item = itemId ? store.item(itemId) : null;
  if (!item) return false;
  const at = now.toISOString();
  const note = 'Changed from the Inbox';
  switch (action) {
    case 'handled': return store.setItemStatus(item.id, { status: 'done', source: 'user', note }, at);
    case 'dismiss': return store.setItemStatus(item.id, { status: 'dropped', source: 'user', note }, at);
    case 'undo':
      return (item.status === 'done' || item.status === 'dropped') && store.setItemStatus(item.id, { status: 'open', source: 'user', note: null }, at);
    case 'tomorrow': return false;
  }
}

/**
 * Rebuilds meeting Inbox rows. Inside refresh this runs right after the
 * portfolio's own reconcile, which switches off every row of each project it
 * observed; this switches current meeting rows back on in the same
 * transaction, so they never disappear. It observes no projects itself, so it
 * never touches task-based rows.
 */
export function applyMeetingAttention(store: MeetingStore, reconcile: Reconcile, visible: readonly PortfolioProject[], now: Date): void {
  store.transaction(() => {
    // A run accepted or stopped since the last rebuild changes which ideas are open.
    store.syncAgentRuns(now.toISOString());
    const candidates = meetingAttention(store, visible, now);
    store.deactivateMeetingAttention();
    reconcile(candidates, [], now.toISOString());
  });
}
