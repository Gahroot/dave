import os from "node:os";
import path from "node:path";

/**
 * All external paths this app is allowed to look at, plus the one directory it
 * may write to. Everything is derived from a home dir so tests can point the
 * whole app at a temp fixture home.
 */
export type SourcePaths = {
  home: string;
  /** The only directory this app writes to. */
  appHome: string;
  ezboss: { links: string; plan: string; sessions: string };
  ezcoder: { taskProjects: string; sessions: string; appWorkspace: string };
  pew2: { knownProjects: string };
  metadataFile: string;
};

export function sourcePaths(
  home = os.homedir(),
  appHome = process.env.PCC_HOME ?? path.join(home, ".portfolio-command-center"),
): SourcePaths {
  const ezcoder = path.join(home, ".ezcoder");
  return {
    home,
    appHome,
    ezboss: {
      links: path.join(ezcoder, "boss", "links.json"),
      plan: path.join(ezcoder, "boss", "plan.json"),
      sessions: path.join(ezcoder, "boss", "sessions"),
    },
    ezcoder: {
      taskProjects: path.join(ezcoder, "tasks", "projects"),
      sessions: path.join(ezcoder, "sessions"),
      appWorkspace: path.join(ezcoder, "ezcoder-app-workspace.json"),
    },
    pew2: { knownProjects: path.join(home, ".pew2", "known-projects.json") },
    metadataFile: path.join(appHome, "portfolio.yaml"),
  };
}

/**
 * Files this app must never open, by basename or suffix. `projects.json` under
 * ~/.ezcoder holds live API secrets; the rest are the usual credential shapes.
 */
const DENIED_BASENAMES = new Set([
  "projects.json",
  "auth.json",
  "credentials.json",
  ".env",
]);
const DENIED_SUFFIXES = [".secret", ".pem", ".key"];

export function isDeniedPath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  return DENIED_SUFFIXES.some((s) => base.endsWith(s));
}
