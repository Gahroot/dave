import { ok, issue, errorMessage } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { readOnlyFs } from "./read-only-fs.ts";
import type { DiscoveryAdapter, DiscoveredProject } from "./types.ts";
import type { SourcePaths } from "../shared/paths.ts";

type LinksFile = { projects?: unknown };

/** Projects the user explicitly linked into EZBoss. */
export function ezbossLinksDiscovery(paths: SourcePaths): DiscoveryAdapter {
  const source = paths.ezboss.links;
  return {
    name: "ezboss-links",
    async discover(): Promise<Result<DiscoveredProject[]>> {
      let file: LinksFile | null;
      try {
        file = await readOnlyFs.readJson<LinksFile>(source);
      } catch (e) {
        return ok([], [issue("ezboss-links", errorMessage(e), source)]);
      }
      if (!file) return ok([]);
      if (!Array.isArray(file.projects)) {
        return ok([], [issue("ezboss-links", "projects is not an array", source)]);
      }
      const out: DiscoveredProject[] = [];
      const issues = [];
      for (const entry of file.projects) {
        const cwd = (entry as { cwd?: unknown })?.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) {
          issues.push(issue("ezboss-links", "entry without a cwd string", source));
          continue;
        }
        const name = (entry as { name?: unknown }).name;
        out.push({
          rawPath: cwd,
          name: typeof name === "string" ? name : null,
          source: "ezboss-links",
        });
      }
      return ok(out, issues);
    },
  };
}
