import path from "node:path";
import fs from "node:fs";
import { canonicalPath, pathExists } from "./canonical-path.ts";
import type { DetectionSignal } from "../shared/types.ts";

/** Discovery source name → the evidence it constitutes. */
const SIGNAL_BY_SOURCE: Record<string, DetectionSignal | null> = {
  "ezboss-links": "ezboss-link",
  "ezcoder-tasks": "ezcoder-record",
  "ezcoder-sessions": "agent-session",
  pew2: "pew2-record",
  // An open editor window is not evidence of a project: it is how the home
  // directory used to appear in the list.
  "ezcoder-app": null,
};

export function signalForSource(source: string): DetectionSignal | null {
  return SIGNAL_BY_SOURCE[source] ?? null;
}

export function hasGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** True for the home directory itself and anything above it. */
export function isHomeOrAbove(canonical: string, home: string): boolean {
  const h = canonicalPath(home);
  const prefix = canonical.endsWith(path.sep) ? canonical : canonical + path.sep;
  return canonical === h || h.startsWith(prefix);
}

function isAncestorOf(parent: string, child: string): boolean {
  if (parent === child) return false;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

export type Candidate = { canonicalPath: string; signals: Set<DetectionSignal> };

export type DetectionResult = {
  accepted: Candidate[];
  /** Rejected paths with the reason, so the UI can explain an absence. */
  rejected: { canonicalPath: string; reason: string }[];
};

/**
 * A directory is a project only with its own evidence: a git repository, an
 * EZCoder record, an EZBoss link, a pew2 registration, or an agent session bound
 * to that exact directory. Containers of other projects are never projects.
 */
export function detectProjects(
  candidates: Map<string, Set<DetectionSignal>>,
  home: string,
): DetectionResult {
  const accepted: Candidate[] = [];
  const rejected: { canonicalPath: string; reason: string }[] = [];

  // Git presence is its own signal, checked on disk rather than inferred.
  for (const [canonical, signals] of candidates) {
    if (pathExists(canonical) && hasGitRepo(canonical)) signals.add("git-repo");
  }

  const all = [...candidates.keys()];
  for (const [canonical, signals] of candidates) {
    if (isHomeOrAbove(canonical, home)) {
      rejected.push({ canonicalPath: canonical, reason: "home directory or above" });
      continue;
    }
    if (signals.size === 0) {
      rejected.push({ canonicalPath: canonical, reason: "no project evidence" });
      continue;
    }
    // A directory that merely contains other projects, with no repository of its
    // own, is a container.
    if (!signals.has("git-repo") && all.some((other) => isAncestorOf(canonical, other))) {
      rejected.push({ canonicalPath: canonical, reason: "contains other projects" });
      continue;
    }
    accepted.push({ canonicalPath: canonical, signals });
  }

  accepted.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  return { accepted, rejected };
}
