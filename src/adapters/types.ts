import type { Result } from "../core/result.ts";
import type { AgentTask } from "../shared/types.ts";

/** Raw git facts. Interpreted as technical activity, never as progress. */
export type GitState = {
  branch: string | null;
  dirty: boolean | null;
  /** Number of entries in `git status --porcelain`. */
  dirtyFileCount: number | null;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  ahead: number | null;
  behind: number | null;
};

export type AgentActivity = {
  lastActivityAt: string | null;
  sessionCount: number;
  /** Distinct days with a session — sustained work, not a single burst. */
  activeDays: number;
  /** Session directory, so summaries can be read on demand. */
  sessionDir: string | null;
  source: string;
};

/** One project location as seen by a single discovery source. */
export type DiscoveredProject = {
  /** Path exactly as the source wrote it; canonicalization happens in the model. */
  rawPath: string;
  name: string | null;
  source: string;
};

export type DiscoveryAdapter = {
  name: string;
  discover(): Promise<Result<DiscoveredProject[]>>;
};

/** Tasks + session activity, keyed by canonical project path. */
export type AgentStateAdapter = {
  name: string;
  read(): Promise<
    Result<Map<string, { tasks: AgentTask[]; activity: AgentActivity }>>
  >;
};

export type GitAdapter = {
  name: string;
  read(projectPath: string): Promise<Result<GitState | null>>;
};
