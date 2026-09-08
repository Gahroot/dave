import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourcePaths } from "../src/shared/paths.ts";
import { ezbossAgentState, normalizeStatus } from "../src/adapters/agent-ezboss.ts";
import { canonicalPath } from "../src/core/canonical-path.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

function home() {
  const dir = tempDir("pcc-agent-");
  const alpha = path.join(dir, "alpha");
  fs.mkdirSync(alpha, { recursive: true });
  return { dir, alpha, paths: sourcePaths(dir, path.join(dir, ".pcc")) };
}

describe("normalizeStatus", () => {
  it("folds both dialects onto one enum", () => {
    expect(normalizeStatus("in_progress")).toBe("in_progress");
    expect(normalizeStatus("in-progress")).toBe("in_progress");
    expect(normalizeStatus("DONE")).toBe("done");
    expect(normalizeStatus("blocked")).toBe("blocked");
    expect(normalizeStatus("skipped")).toBe("skipped");
    expect(normalizeStatus("weird")).toBe("unknown");
    expect(normalizeStatus(7)).toBe("unknown");
  });
});

describe("ezbossAgentState", () => {
  it("reads ezcoder tasks and truncates prompts to a short summary", async () => {
    const { alpha, paths } = home();
    writeJson(path.join(paths.ezcoder.taskProjects, "h1", "meta.json"), { path: alpha });
    writeJson(path.join(paths.ezcoder.taskProjects, "h1", "tasks.json"), [
      { id: "t1", title: "Fix it", prompt: "x".repeat(500), status: "in-progress", createdAt: "2026-08-01T00:00:00Z" },
    ]);
    const r = await ezbossAgentState(paths, new Map()).read();
    const state = r.data.get(canonicalPath(alpha))!;
    expect(state.tasks[0]).toMatchObject({ status: "in_progress", title: "Fix it" });
    expect(state.tasks[0]!.summary!.length).toBeLessThanOrEqual(200);
    expect(state.tasks[0]!.updatedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("tolerates an absent plan.json", async () => {
    const { paths } = home();
    const r = await ezbossAgentState(paths, new Map()).read();
    expect(r.issues).toEqual([]);
  });

  it("maps plan tasks through link names and flags unknown projects", async () => {
    const { alpha, paths } = home();
    writeJson(paths.ezboss.plan, {
      tasks: [
        { id: "p1", project: "alpha", title: "Boss task", status: "blocked", notes: "stuck" },
        { id: "p2", project: "ghost", title: "Orphan", status: "pending" },
      ],
    });
    const links = new Map([["alpha", canonicalPath(alpha)]]);
    const r = await ezbossAgentState(paths, links).read();
    expect(r.data.get(canonicalPath(alpha))!.tasks[0]).toMatchObject({
      status: "blocked",
      summary: "stuck",
      source: "ezboss-plan",
    });
    expect(r.issues[0]!.message).toMatch(/unknown project "ghost"/);
  });

  it("records session mtimes and counts without reading bodies", async () => {
    const { alpha, paths } = home();
    const dir = path.join(paths.ezcoder.sessions, "enc");
    writeText(path.join(dir, "a.jsonl"), JSON.stringify({ cwd: alpha }) + "\n");
    writeText(path.join(dir, "b.jsonl"), JSON.stringify({ cwd: alpha }) + "\n");
    const r = await ezbossAgentState(paths, new Map()).read();
    const activity = r.data.get(canonicalPath(alpha))!.activity;
    expect(activity.sessionCount).toBe(2);
    expect(Date.parse(activity.lastActivityAt!)).toBeGreaterThan(0);
  });

  it("reports a non-array tasks.json but keeps going", async () => {
    const { alpha, paths } = home();
    writeJson(path.join(paths.ezcoder.taskProjects, "h1", "meta.json"), { path: alpha });
    writeJson(path.join(paths.ezcoder.taskProjects, "h1", "tasks.json"), { nope: true });
    const r = await ezbossAgentState(paths, new Map()).read();
    expect(r.issues[0]!.message).toMatch(/not an array/);
  });

  it("reports corrupt task JSON as an issue", async () => {
    const { alpha, paths } = home();
    writeJson(path.join(paths.ezcoder.taskProjects, "h1", "meta.json"), { path: alpha });
    writeText(path.join(paths.ezcoder.taskProjects, "h1", "tasks.json"), "[{");
    const r = await ezbossAgentState(paths, new Map()).read();
    expect(r.issues).toHaveLength(1);
  });
});
