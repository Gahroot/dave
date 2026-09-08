import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DisallowedGitCommandError, gitAdapter, runGit } from "../src/adapters/git.ts";
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

  it("returns null for a directory that is not a repository", async () => {
    const r = await gitAdapter().read(tempDir("pcc-norepo-"));
    expect(r.data).toBeNull();
    expect(r.issues).toEqual([]);
  });
});
