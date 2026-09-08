import path from "node:path";
import { errorMessage, issue, ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { pathExists } from "../core/canonical-path.ts";
import { readOnlyFs } from "./read-only-fs.ts";
import { readEzcoderSessionDirs } from "./ezcoder-sessions.ts";
import type { DiscoveryAdapter, DiscoveredProject } from "./types.ts";
import type { SourcePaths } from "../shared/paths.ts";

type Meta = { path?: unknown; name?: unknown };
type Workspace = { windows?: unknown };

/**
 * Three EZCoder hints: the per-project task store, the desktop app's open
 * windows, and the session directories.
 */
export function ezcoderDiscovery(paths: SourcePaths): DiscoveryAdapter {
  return {
    name: "ezcoder",
    async discover(): Promise<Result<DiscoveredProject[]>> {
      const out: DiscoveredProject[] = [];
      const issues = [];

      // 1. Task store: <hash>/meta.json carries the true path and display name.
      const root = paths.ezcoder.taskProjects;
      for (const entry of await readOnlyFs.readdir(root)) {
        const metaPath = path.join(root, entry, "meta.json");
        try {
          const meta = await readOnlyFs.readJson<Meta>(metaPath);
          if (!meta) continue;
          if (typeof meta.path !== "string" || !meta.path) {
            issues.push(issue("ezcoder", "meta.json without a path string", metaPath));
            continue;
          }
          out.push({
            rawPath: meta.path,
            name: typeof meta.name === "string" ? meta.name : null,
            source: "ezcoder-tasks",
          });
        } catch (e) {
          issues.push(issue("ezcoder", errorMessage(e), metaPath));
        }
      }

      // 2. Desktop app windows.
      const wsPath = paths.ezcoder.appWorkspace;
      try {
        const ws = await readOnlyFs.readJson<Workspace>(wsPath);
        if (ws && !Array.isArray(ws.windows)) {
          issues.push(issue("ezcoder", "windows is not an array", wsPath));
        } else {
          for (const w of (ws?.windows ?? []) as { cwd?: unknown }[]) {
            if (typeof w?.cwd === "string" && w.cwd) {
              out.push({ rawPath: w.cwd, name: null, source: "ezcoder-app" });
            }
          }
        }
      } catch (e) {
        issues.push(issue("ezcoder", errorMessage(e), wsPath));
      }

      // 3. Session directories (cwd from the header line).
      const sessions = await readEzcoderSessionDirs(paths);
      issues.push(...sessions.issues);
      for (const s of sessions.data) {
        // Decoded dir names can be wrong, so only trust ones that exist.
        if (s.cwd && pathExists(s.cwd)) {
          out.push({ rawPath: s.cwd, name: null, source: "ezcoder-sessions" });
        }
      }

      return ok(out, issues);
    },
  };
}
