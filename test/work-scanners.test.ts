import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openDb, type Db } from "../src/db/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { parseHead, parseTail, scanEzcoderRuns, TAIL_BYTES } from "../src/work/ezcoder-runs.ts";
import { parseWorkLog, scanGit } from "../src/work/git-events.ts";
import { GH_ARGV, parsePrList, scanGithub } from "../src/work/github.ts";
import { mainCheckout, projectForCwd } from "../src/work/worktree.ts";
import { parseMarkers } from "../src/work/text.ts";
import { assistantRow, git, initRepo, runFinished, sessionHeader, userRow, workRoot, writeSession } from "./work-fixtures.ts";

const OBJ = "0123456789abcdef";
const ITEM = "fedcba9876543210";
const roots: string[] = [];
const dbs: Db[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function setup() {
  const root = workRoot(); roots.push(root);
  const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
  const db = openDb(paths.appHome); dbs.push(db);
  return { root, paths, db };
}

describe("markers", () => {
  it("reads the DAVE-Objective and DAVE-Items markers", () => {
    expect(parseMarkers(`Do it\n\nDAVE-Objective: ${OBJ}\nDAVE-Items: ${ITEM},nothex, ${OBJ}\nmore`)).toEqual({ objectiveId: OBJ, itemIds: [OBJ, ITEM] });
    expect(parseMarkers("no markers")).toEqual({ objectiveId: null, itemIds: [] });
  });
});

describe("EZ Coder session runs", () => {
  it("emits one event per run_finished with the marker, redacted summary and cursor", async () => {
    const { paths, db } = setup();
    const cwd = path.join(paths.home, "code", "acme");
    writeSession(paths.ezcoder.sessions, "Users_x_acme", "2026-10-12T08-00-00_s1.jsonl", [
      sessionHeader("s1", cwd),
      userRow(`Objective: Build CSV export\nProject: Acme\n\nDAVE-Objective: ${OBJ}\nDAVE-Items: ${ITEM}`),
      assistantRow("First pass done"),
      runFinished(1, "failed", "2026-10-12T08:06:00.000Z"),
      assistantRow("CSV export added. token sk-proj-abcdefghijklmnopqrstuvwxyz123456"),
      runFinished(2, "completed", "2026-10-12T08:10:00.000Z"),
      { type: "custom", kind: "run_finished", data: { generation: 3, outcome: "exploded" } },
    ]);
    const runs = await scanEzcoderRuns(db, paths, "2026-10-12T09:00:00.000Z");
    expect(runs.map((r) => [r.sessionId, r.generation, r.outcome])).toEqual([["s1", 1, "failed"], ["s1", 2, "completed"]]);
    expect(runs[1]).toMatchObject({ cwd, title: "Build CSV export", at: "2026-10-12T08:10:00.000Z", marker: { objectiveId: OBJ, itemIds: [ITEM] } });
    expect(runs[1]?.summary).toContain("CSV export added");
    expect(runs[1]?.summary).not.toContain("sk-proj");
    // Unchanged file: the cursor means it is not read again.
    expect(await scanEzcoderRuns(db, paths, "2026-10-12T09:01:00.000Z")).toEqual([]);
  });

  it("skips a partial first tail line and a cut-off head line", () => {
    const row = JSON.stringify(runFinished(4, "unverified", "2026-10-12T10:00:00.000Z"));
    const partial = `"generation":9,"outcome":"completed"}}\n${row}\n`;
    expect(parseTail(partial, true).map((r) => r.generation)).toEqual([4]);
    expect(parseHead(`${JSON.stringify(sessionHeader("s2", "/x"))}\n{"type":"mess`, false)).toEqual({ sessionId: "s2", cwd: "/x", firstUser: null });
    expect(TAIL_BYTES).toBe(65536);
  });
});

describe("worktree mapping", () => {
  it("maps a live worktree to its main checkout and a deleted one by unique name", async () => {
    const { paths } = setup();
    const main = path.join(paths.home, "code", "acme");
    initRepo(main);
    const wt = path.join(paths.home, ".ezcoder", "worktrees", "acme", "ez-live");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(main, "worktree", "add", "-q", wt);
    const projects = [{ id: "p1", name: "Acme", path: main }, { id: "p2", name: "Other", path: path.join(paths.home, "code", "other") }];
    expect(await mainCheckout(path.join(wt))).toBe(fs.realpathSync(main));
    expect((await projectForCwd(wt, projects, paths.home))?.id).toBe("p1");
    expect((await projectForCwd(path.join(main, "src"), projects, paths.home))?.id).toBe("p1");
    const gone = path.join(paths.home, ".ezcoder", "worktrees", "acme", "ez-deleted");
    expect((await projectForCwd(gone, projects, paths.home))?.id).toBe("p1");
    // Two projects named acme: ambiguous, so the event is dropped.
    expect(await projectForCwd(gone, [...projects, { id: "p3", name: "Acme 2", path: path.join(paths.home, "client", "acme") }], paths.home)).toBeNull();
    expect(await projectForCwd(path.join(paths.home, "elsewhere"), projects, paths.home)).toBeNull();
  });
});

describe("local git events", () => {
  it("reports a merge and a trailer, only back to the last seen sha", async () => {
    const { paths, db } = setup();
    const repo = path.join(paths.home, "code", "acme");
    initRepo(repo);
    const projects = [{ id: "p1", name: "Acme", path: repo }];
    // First sighting: only commits carrying the trailer would be reported; there are none.
    expect((await scanGit(db, projects, "2026-10-12T09:00:00.000Z")).events).toEqual([]);
    git(repo, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(repo, "csv.ts"), "export {}\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Add CSV export", "-m", `DAVE-Objective: ${OBJ}`);
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "feature", "-m", "Merge feature CSV export");
    const { events } = await scanGit(db, projects, "2026-10-12T09:01:00.000Z");
    expect(events.map((e) => [e.kind, e.outcome, e.title])).toEqual([["merge", "merged", "Merge feature CSV export"]]);
    // --first-parent hides the feature commit; a direct commit with a trailer is read.
    fs.writeFileSync(path.join(repo, "b.ts"), "export {}\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Wire the export button", "-m", `DAVE-Objective: ${OBJ}`);
    const next = await scanGit(db, projects, "2026-10-12T09:02:00.000Z");
    expect(next.events.map((e) => [e.kind, e.marker.objectiveId])).toEqual([["commit", OBJ]]);
    expect((await scanGit(db, projects, "2026-10-12T09:03:00.000Z")).events).toEqual([]);
  });

  it("parses NUL/RS delimited records", () => {
    const sha = "a".repeat(40);
    expect(parseWorkLog(`${sha}\x002026-10-12T09:00:00+02:00\x00${"b".repeat(40)} ${"c".repeat(40)}\x00Merge\x00${OBJ}\n\x1e\n`)).toEqual([
      { sha, at: "2026-10-12T07:00:00.000Z", parents: ["b".repeat(40), "c".repeat(40)], subject: "Merge", objectiveId: OBJ },
    ]);
  });
});

describe("GitHub merged pull requests", () => {
  const prs = (list: object[]) => JSON.stringify(list);
  it("reads fake gh JSON for GitHub projects only, keeps a short redacted summary, never throws", async () => {
    const { paths, db } = setup();
    const repo = path.join(paths.home, "code", "acme");
    initRepo(repo);
    git(repo, "remote", "add", "origin", "git@github.com:me/acme.git");
    const local = path.join(paths.home, "code", "local");
    initRepo(local);
    const calls: { cwd: string; argv: readonly string[] }[] = [];
    const body = `Adds export.\n\nDAVE-Objective: ${OBJ}\nDAVE-Items: ${ITEM}\n${"x ".repeat(500)}`;
    const runGh = async (cwd: string, argv: readonly string[]) => {
      calls.push({ cwd, argv });
      return prs([{ number: 7, title: "CSV export", mergedAt: "2026-10-12T08:00:00Z", body, headRefName: "csv" }, { number: "bad" }, { number: 6, title: "Old", mergedAt: "2026-10-01T08:00:00Z", body: "", headRefName: "x" }]);
    };
    const projects = [{ id: "p1", name: "Acme", path: repo }, { id: "p2", name: "Local", path: local }];
    const r = await scanGithub(db, projects, "2026-10-12T09:00:00.000Z", runGh);
    expect(calls).toEqual([{ cwd: repo, argv: GH_ARGV }]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ ref: "#7", kind: "pr_merged", outcome: "merged", marker: { objectiveId: OBJ, itemIds: [ITEM] } });
    expect(r.events[0]?.summary?.length).toBeLessThanOrEqual(600);
    expect(r.events[0]?.summary).not.toContain("DAVE-Objective");
    expect((await scanGithub(db, projects, "2026-10-12T09:10:00.000Z", runGh)).events).toEqual([]);
    const broken = await scanGithub(db, projects, "2026-10-12T09:20:00.000Z", async () => { throw new Error("gh: not logged in"); });
    expect(broken).toMatchObject({ events: [], failures: 1 });
    expect(() => parsePrList("{}")).toThrow();
  });
});
