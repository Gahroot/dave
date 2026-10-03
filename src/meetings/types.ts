/**
 * Meeting types shared by the server and the UI. Type-only: no Node imports,
 * so the browser bundle can use them.
 */
export type HistoryDays = 7 | 30 | 90;
export const HISTORY_DAYS: readonly HistoryDays[] = [7, 30, 90];

export type SpeakerRoleName = 'me' | 'client' | 'teammate' | 'unknown';

export type MeetingSettings = {
  fathomEmail: string;
  nameAliases: string[];
  historyDays: HistoryDays;
  paused: boolean;
  ignoreWords: string[];
  autoExtract: boolean;
  consentVersion: string | null;
  consentAt: string | null;
  connectedAt: string | null;
  updatedAt: string;
};

export type KeyState = 'unknown' | 'valid' | 'invalid';

export type MeetingSyncState = {
  keyState: KeyState;
  lastSuccessAt: string | null;
  cursor: string | null;
  cursorSince: string | null;
  cursorStartedAt: string | null;
  backoffUntil: string | null;
  failures: number;
  lastError: string | null;
  lastRunAt: string | null;
  followupAt: string | null;
};

export type SyncStats = {
  pages: number;
  listed: number;
  added: number;
  transcripts: number;
  skipped: number;
  unavailable: number;
  invalid: number;
};

export type SyncRun = {
  id: number;
  trigger: 'schedule' | 'manual';
  outcome: 'ok' | 'partial' | 'error' | 'skipped';
  stats: Partial<SyncStats>;
  error: string | null;
  startedAt: string;
  finishedAt: string;
};

export type MeetingStatus = 'waiting' | 'unavailable' | 'skipped' | 'imported' | 'analyzed' | 'failed' | 'forgotten';

export type MeetingAttendee = {
  name: string | null;
  email: string | null;
  domain: string | null;
  external: boolean;
  speakerName: string | null;
};

export type ItemKind = 'commitment' | 'suggestion' | 'pain_point' | 'decision';
export type ItemStatus = 'open' | 'planned' | 'looks_done' | 'done' | 'dropped';
export type ItemStatusSource = 'model' | 'user' | 'evidence' | 'meeting' | 'agent';
export type ProjectSource = 'model' | 'user' | 'rule' | 'meeting';

export type FeatureIdea = { title: string; outcome: string; acceptance: string[] };

export type MeetingItem = {
  id: string;
  recordingId: string;
  kind: ItemKind;
  text: string;
  quote: string;
  atSeconds: number;
  speaker: string;
  speakerRole: SpeakerRoleName;
  projectId: string | null;
  projectName: string | null;
  projectSource: ProjectSource | null;
  duePhrase: string | null;
  dueDate: string | null;
  feature: FeatureIdea | null;
  status: ItemStatus;
  /** Set while status is looks_done: what the evidence suggests. */
  suggestedStatus: 'done' | 'dropped' | null;
  statusSource: ItemStatusSource;
  statusNote: string | null;
  statusChangedAt: string | null;
  edited: boolean;
  agentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  meetingTitle: string;
  meetingAt: string;
  meetingUrl: string | null;
};

export type MeetingSummary = { headline: string; overview: string; direction: string[] };

export type MeetingCounts = { commitment: number; suggestion: number; pain_point: number; decision: number };

export type MeetingRow = {
  recordingId: string;
  title: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  url: string | null;
  external: boolean;
  attendees: MeetingAttendee[];
  status: MeetingStatus;
  skipReason: string | null;
  error: string | null;
  projectId: string | null;
  projectName: string | null;
  projectSource: 'rule' | 'user' | 'model' | null;
  transcriptBytes: number | null;
  headline: string | null;
  analyzedAt: string | null;
  /** Analyzed with reading instructions that have since changed. */
  staleInstructions: boolean;
  counts: MeetingCounts;
};

export type MeetingDetail = MeetingRow & {
  calendarTitle: string | null;
  shareUrl: string | null;
  summary: MeetingSummary | null;
  model: string | null;
  analysisStats: Record<string, number> | null;
  items: MeetingItem[];
};

export type ProjectRule = { id: number; kind: 'domain' | 'title'; pattern: string; projectId: string; projectName: string | null; createdAt: string };

export type InstructionsProfile = { id: number | null; source: 'default' | 'user'; instructions: string; createdAt: string | null; hash: string };

/** Local work since the project's last call: never sent anywhere by this view. */
export type ActivityEvidence = { id: string; kind: 'commit' | 'run' | 'milestone' | 'task'; at: string; title: string };

export type PromiseStateName = 'overdue' | 'due_soon' | 'not_followed_up' | 'open';

export type ProjectMeetingsOverview = {
  items: MeetingItem[];
  /** For open promises: the same state the Inbox uses (overdue, due soon, not followed up). */
  promiseStates: Record<string, PromiseStateName>;
  lastCall: { recordingId: string; title: string; at: string; headline: string | null; direction: string[] } | null;
  sinceLastCall: ActivityEvidence[];
};

export type Disclosure = {
  title: string;
  sections: { title: string; items: string[] }[];
  notes: string[];
};

/** Everything the Fathom card and Meetings page need to show the feature's state. */
export type MeetingsState = {
  key: { saved: boolean; state: KeyState; storageError: boolean };
  settings: MeetingSettings;
  sync: Omit<MeetingSyncState, 'cursor' | 'cursorSince' | 'cursorStartedAt'> & { running: boolean; intervalMs: number };
  runs: SyncRun[];
  analysis: {
    disclosure: Disclosure & { version: string };
    /** Automatic analysis is on with consent to the current disclosure. */
    on: boolean;
    /** The switch is on, but the disclosure changed since consent. */
    consentOutdated: boolean;
    openAIConnected: boolean;
    running: string | null;
    queued: string[];
  };
};
