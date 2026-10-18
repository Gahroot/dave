import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HEAD_SHA_ARGV, WORK_LOG_ARGV, DATED_SUBJECTS_ARGV, datedCommitSubjects, DisallowedGitCommandError, gitAdapter, runGit } from "../src/adapters/git.ts";
import { tempDir } from "./helpers.ts";

const repo = path.join(tempDir("pcc-git-"), "repo");

beforeAll(() => {
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello");
  git("add", "a.txt");
  git("commit", "-qm", "first commit");
});

describe("work watcher argv", () => {
  it("allows exactly rev-parse HEAD and the fixed first-parent log", async () => {
    expect(HEAD_SHA_ARGV).toEqual(["rev-parse", "HEAD"]);
    expect((await runGit(repo, HEAD_SHA_ARGV)).trim()).toMatch(/^[a-f0-9]{40}$/);
    expect(await runGit(repo, WORK_LOG_ARGV)).toContain("first commit");
  });
});

describe("runGit allow-list", () => {
  const mutating = [
    ["commit", "-m", "x"],
    ["push"],
    ["checkout", "main"],
    ["clean", "-fd"],
    ["reset", "--hard"],
    ["gc"],
    ["config", "user.name", "x"],
    ["status"], // right verb, wrong argv shape
    ["log", "-1", "--format=%H", "--", "; rm -rf /"],
    // The meeting follow-up shape, but with a different count or format.
    ["log", "-31", "--format=%cI%x00%s"],
    ["log", "-30", "--format=%cI%x00%s%x00%b"],
    // Work watcher shapes, but altered.
    ["rev-parse", "HEAD~1"],
    ["log", "-51", "--first-parent", "--format=%H%x00%cI%x00%P%x00%s%x00%(trailers:key=DAVE-Objective,valueonly,separator=%x2C)%x1e"],
    ["log", "-50", "--format=%H%x00%cI%x00%P%x00%s%x00%(trailers:key=DAVE-Objective,valueonly,separator=%x2C)%x1e"],
  ];

  it.each(mutating)("refuses `git %s`", async (...argv) => {
    await expect(runGit(repo, argv)).rejects.toBeInstanceOf(DisallowedGitCommandError);
  });

  it("throws before spawning anything", async () => {
    // A DisallowedGitCommandError proves the guard ran ahead of execFile;
    // an actual spawn of `git nonsense` would surface an exit-code error instead.
    await expect(runGit(repo, ["nonsense"])).rejects.toThrow(/allow-list/);
  });
});

describe("gitAdapter", () => {
  it("reads branch, cleanliness and the last commit", async () => {
    const r = await gitAdapter().read(repo);
    expect(r.issues).toEqual([]);
    expect(r.data).toMatchObject({
      branch: "main",
      dirty: false,
      lastCommitSubject: "first commit",
      ahead: null,
      behind: null,
    });
    expect(Date.parse(r.data!.lastCommitAt!)).toBeGreaterThan(0);
  });

  it("detects a dirty worktree", async () => {
    fs.writeFileSync(path.join(repo, "b.txt"), "dirty");
    expect((await gitAdapter().read(repo)).data!.dirty).toBe(true);
    fs.unlinkSync(path.join(repo, "b.txt"));
  });

  it("reads dated commit subjects with the one fixed follow-up command", async () => {
    expect(DATED_SUBJECTS_ARGV).toEqual(["log", "-30", "--format=%cI%x00%s"]);
    const commits = await datedCommitSubjects(repo);
    expect(commits).toEqual([{ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), subject: "first commit" }]);
    expect(await datedCommitSubjects(tempDir("pcc-norepo-"))).toEqual([]);
  });

  it("returns null for a directory that is not a repository", async () => {
    const r = await gitAdapter().read(tempDir("pcc-norepo-"));
    expect(r.data).toBeNull();
    expect(r.issues).toEqual([]);
  });
});
