import { ok, issue, errorMessage } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { readOnlyFs } from "./read-only-fs.ts";
import type { DiscoveryAdapter, DiscoveredProject } from "./types.ts";
import type { SourcePaths } from "../shared/paths.ts";

/** pew2 stores a flat array of chosen project paths. */
export function pew2Discovery(paths: SourcePaths): DiscoveryAdapter {
  const source = paths.pew2.knownProjects;
  return {
    name: "pew2",
    async discover(): Promise<Result<DiscoveredProject[]>> {
      let list: unknown;
      try {
        list = await readOnlyFs.readJson<unknown>(source);
      } catch (e) {
        return ok([], [issue("pew2", errorMessage(e), source)]);
      }
      if (list === null) return ok([]);
      if (!Array.isArray(list)) {
        return ok([], [issue("pew2", "known-projects.json is not an array", source)]);
      }
      const out = list
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => ({ rawPath: p, name: null, source: "pew2" }));
      const skipped = list.length - out.length;
      return ok(
        out,
        skipped ? [issue("pew2", `${skipped} non-string entries ignored`, source)] : [],
      );
    },
  };
}
