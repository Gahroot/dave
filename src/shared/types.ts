/**
 * Read-only is scoped: EZCoder, EZBoss, pew2 and every project repo stay
 * untouched. The command center writes and maintains its own storage
 * automatically — the user is never asked to fill it in.
 */

export type EvidenceKind =
  | "detection"
  | "file"
  | "git"
  | "ezcoder-task"
  | "ezboss-task"
  | "session"
  | "package";

/** A pointer to what was actually read. Never a whole file. */
export type EvidenceRef = {
  kind: EvidenceKind;
  path: string | null;
  detail: string;
  observedAt: string;
};

/** Why a directory counts as a project at all. */
export type DetectionSignal =
  | "git-repo"
  | "ezcoder-record"
  | "ezboss-link"
  | "pew2-record"
  | "agent-session";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "skipped"
  | "unknown";

export type AgentTask = {
  id: string;
  title: string;
  status: TaskStatus;
  summary: string | null;
  updatedAt: string | null;
  source: string;
};

/**
 * Observed machine facts. Named "technical activity" deliberately: a commit
 * proves files moved, not that the business moved.
 */
export type TechnicalActivity = {
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  recentCommitSubjects: string[];
  branch: string | null;
  dirty: boolean | null;
  /** Files in the working tree that are modified but not committed. */
  dirtyFileCount: number | null;
  lastAgentSessionAt: string | null;
  sessionCount: number;
  /** Distinct days with an agent session in the recent window. */
  activeDayCount: number;
  lastTaskUpdateAt: string | null;
  openTaskCount: number;
  blockedTaskCount: number;
  runningTaskCount: number;
  doneTaskCount: number;
  lastTechnicalActivityAt: string | null;
};

export function emptyActivity(): TechnicalActivity {
  return {
    lastCommitAt: null,
    lastCommitSubject: null,
    recentCommitSubjects: [],
    branch: null,
    dirty: null,
    dirtyFileCount: null,
    lastAgentSessionAt: null,
    sessionCount: 0,
    activeDayCount: 0,
    lastTaskUpdateAt: null,
    openTaskCount: 0,
    blockedTaskCount: 0,
    runningTaskCount: 0,
    doneTaskCount: 0,
    lastTechnicalActivityAt: null,
  };
}

/** One contribution to a project's relevance, always explainable. */
export type RelevanceReason = {
  code:
    | "human-request"
    | "running-worker"
    | "open-task"
    | "recent-session"
    | "repeat-activity"
    | "recent-commit"
    | "uncommitted-work"
    | "blocked-task"
    | "pinned";
  points: number;
  detail: string;
};

export type Relevance = {
  score: number;
  reasons: RelevanceReason[];
  /** Derived from the score plus any user override. */
  tier: "active" | "other";
};

/**
 * The four questions every project answers with no setup. Each answer is either
 * observed from evidence or absent — never a demand on the user.
 */
export type ProjectSummary = {
  /** What was most recently being worked on. */
  recentFocus: string | null;
  /** What appears to have been completed. */
  completed: string | null;
  /** What appears unfinished or blocked. */
  unfinished: string | null;
  /** The most likely next action. Always a suggestion. */
  suggestedNextAction: string | null;
  evidence: EvidenceRef[];
  generatedAt: string;
  /** True when the user edited this summary by hand. */
  edited: boolean;
};

export function emptySummary(generatedAt: string): ProjectSummary {
  return {
    recentFocus: null,
    completed: null,
    unfinished: null,
    suggestedNextAction: null,
    evidence: [],
    generatedAt,
    edited: false,
  };
}

/** Optional, lightweight, never required. */
export type ProjectOverride = {
  pinned: boolean;
  hidden: boolean;
};

export type ProjectAlias = { path: string; source: string };

export type PortfolioProject = {
  id: string;
  canonicalPath: string;
  name: string;
  exists: boolean;
  scanStatus?: "checked" | "cached" | "unavailable";
  tasksObserved?: boolean;
  signals: DetectionSignal[];
  aliases: ProjectAlias[];
  sources: string[];
  activity: TechnicalActivity;
  tasks: AgentTask[];
  /** Where this project's agent sessions live, for on-demand summary reads. */
  sessionDir: string | null;
  relevance: Relevance;
  summary: ProjectSummary;
  override: ProjectOverride;
};

/** Only events that genuinely need a human. Never metadata chores. */
export type InboxKind =
  | "approval-request"
  | "failed-run"
  | "agent-question"
  | "ready-for-review"
  | "conflicting-work"
  | "inspection";

export type InboxStatus = "open" | "acknowledged" | "dismissed";

export type AttentionAction = "handled" | "tomorrow" | "dismiss" | "undo";
export type AttentionCandidate = {
  projectId: string;
  subjectKey: string;
  fingerprint: string;
  legacyDedupeKey?: string;
  kind: InboxKind;
  title: string;
  detail: string;
  evidence: EvidenceRef[];
  urgency: number;
  nextStep: string;
};
export type Coverage = {
  checked: number;
  cached: number;
  unavailable: number;
  waitingOutsideCap: number;
};

export type InboxItem = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: InboxKind;
  title: string;
  detail: string;
  evidence: EvidenceRef[];
  status: InboxStatus;
  createdAt: string;
  resolvedAt: string | null;
  subjectKey: string | null;
  fingerprint: string | null;
  active: boolean;
  lastObservedAt: string | null;
  snoozedUntil: string | null;
  seenAt: string | null;
  urgency: number;
  nextStep: string;
};

export type TodayItem = {
  projectId: string;
  projectName: string;
  title: string;
  why: string;
  urgency: number;
  evidence: EvidenceRef[];
};

export type PortfolioIssue = {
  adapter: string;
  path: string | null;
  message: string;
  observedAt: string;
};

export type Portfolio = {
  generatedAt: string;
  coverage?: Coverage;
  history?: InboxItem[];
  remainingCount?: number;
  newCount?: number;
  stale?: boolean;
  refreshError?: string;
  active: PortfolioProject[];
  other: PortfolioProject[];
  hidden: PortfolioProject[];
  today: TodayItem[];
  inbox: InboxItem[];
  issues: PortfolioIssue[];
};
