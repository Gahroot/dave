import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectProjects, isHomeOrAbove, signalForSource } from "../src/core/detect.ts";
import { canonicalPath } from "../src/core/canonical-path.ts";
import type { DetectionSignal } from "../src/shared/types.ts";
import { tempDir } from "./helpers.ts";

function candidates(entries: [string, DetectionSignal[]][]) {
  return new Map(entries.map(([p, s]) => [canonicalPath(p), new Set(s)]));
}

describe("signalForSource", () => {
  it("counts real project registries as evidence", () => {
    expect(signalForSource("ezboss-links")).toBe("ezboss-link");
    expect(signalForSource("ezcoder-tasks")).toBe("ezcoder-record");
    expect(signalForSource("ezcoder-sessions")).toBe("agent-session");
    expect(signalForSource("pew2")).toBe("pew2-record");
  });

  it("does not treat an open editor window as evidence", () => {
    expect(signalForSource("ezcoder-app")).toBeNull();
  });
});

describe("detectProjects", () => {
  const home = "/Users/example";

  it("rejects the home directory and everything above it", () => {
    const result = detectProjects(
      candidates([
        [home, ["agent-session"]],
        ["/Users", ["agent-session"]],
        ["/", ["agent-session"]],
      ]),
      home,
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "home directory or above",
      "home directory or above",
      "home directory or above",
    ]);
  });

  it("rejects a directory that merely contains other projects", () => {
    const result = detectProjects(
      candidates([
        ["/Users/example/code", ["agent-session"]],
        ["/Users/example/code/alpha", ["ezboss-link"]],
      ]),
      home,
    );
    expect(result.accepted.map((a) => a.canonicalPath)).toEqual([
      canonicalPath("/Users/example/code/alpha"),
    ]);
    expect(result.rejected[0]!.reason).toBe("contains other projects");
  });

  it("keeps a parent that has its own repository (a monorepo root)", () => {
    const dir = tempDir("pcc-mono-");
    const root = path.join(dir, "mono");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    const result = detectProjects(
      candidates([
        [root, ["ezboss-link"]],
        [path.join(root, "pkg"), ["ezboss-link"]],
      ]),
      dir + "/home",
    );
    expect(result.accepted).toHaveLength(2);
  });

  it("rejects a directory with no evidence at all", () => {
    const result = detectProjects(candidates([["/Users/example/random", []]]), home);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("no project evidence");
  });

  it("accepts a directory on any single real signal", () => {
    for (const s of ["ezboss-link", "ezcoder-record", "agent-session", "pew2-record"] as const) {
      const r = detectProjects(candidates([["/Users/example/a", [s]]]), home);
      expect(r.accepted).toHaveLength(1);
    }
  });

  it("adds git-repo as its own signal when a repository exists on disk", () => {
    const dir = tempDir("pcc-git-sig-");
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const r = detectProjects(candidates([[proj, []]]), path.join(dir, "home"));
    expect([...r.accepted[0]!.signals]).toEqual(["git-repo"]);
  });

  it("isHomeOrAbove handles root and sibling prefixes", () => {
    expect(isHomeOrAbove(canonicalPath("/"), home)).toBe(true);
    expect(isHomeOrAbove(canonicalPath("/Users/exam"), home)).toBe(false);
    expect(isHomeOrAbove(canonicalPath("/Users/example/x"), home)).toBe(false);
  });
});
