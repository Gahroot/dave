import { describe, expect, it, vi, beforeAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Portfolio } from "../src/shared/types.ts";
import { handoff } from "../src/ui/format.ts";

/** Records every spawn and every file opened, then delegates to the real thing. */
const spawns: string[][] = [];
const opened: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      spawns.push([file, ...(Array.isArray(args) ? args : [])]);
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, ...rest);
    }) as typeof actual.execFile,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const track = <A extends unknown[], R>(fn: (...a: A) => R) =>
    ((...a: A) => {
      opened.push(String(a[0]));
      return fn(...a);
    }) as (...a: A) => R;
  const wrapped = { ...actual, readFile: track(actual.readFile), open: track(actual.open) };
  return { ...wrapped, default: wrapped };
});

const { sourcePaths, isDeniedPath } = await import("../src/shared/paths.ts");
const { canonicalPath } = await import("../src/core/canonical-path.ts");

/** The spy records realpaths; compare canonically or a match is silently missed. */
const openedCanonical = () => opened.map((p) => canonicalPath(p));
const { buildServer } = await import("../src/server/index.ts");
const { openDb } = await import("../src/db/index.ts");
const { repo: makeRepo } = await import("../src/db/repo.ts");
const { refresh } = await import("../src/model/refresh.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-guarantee-"));
const home = path.join(root, "home");
const appHome = path.join(root, "app");
const project = path.join(home, "code", "alpha");
const paths = sourcePaths(home, appHome);
const SECRET = path.join(home, ".ezcoder", "projects.json");
const PROJECT_ENV = path.join(project, ".env");

/** Content + metadata fingerprint of a whole tree. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.lstatSync(full);
      const body = entry.isSymbolicLink()
        ? fs.readlinkSync(full)
        : fs.readFileSync(full).toString("base64");
      out[rel] = `${stat.size}:${stat.mtimeMs}:${crypto.createHash("sha256").update(body).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

beforeAll(() => {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.dirname(paths.ezboss.links), { recursive: true });
  fs.writeFileSync(paths.ezboss.links, JSON.stringify({ projects: [{ name: "alpha", cwd: project }] }));
  fs.writeFileSync(SECRET, JSON.stringify({ apiKey: "sk_live_do_not_read" }));
  const taskDir = path.join(paths.ezcoder.taskProjects, "alpha");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "meta.json"), JSON.stringify({ name: "alpha", path: project }));
  fs.writeFileSync(path.join(taskDir, "tasks.json"), JSON.stringify([{ id: "ignored", title: "never ingest", status: "pending" }]));
  fs.writeFileSync(paths.ezboss.plan, JSON.stringify({ tasks: [{ project: "alpha", id: "approval", title: "needs your approval to publish", status: "pending" }] }));
  fs.writeFileSync(path.join(project, "README.md"), "# Alpha\n\nA portal.\n");
  fs.writeFileSync(path.join(project, "PLAN.md"), "## Next\n- [ ] do the thing\n");
  fs.writeFileSync(PROJECT_ENV, "PROJECT_SECRET=hunter2");
  fs.mkdirSync(path.join(project, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(project, "node_modules", "dep", "README.md"), "# dep");

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: project,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "README.md", "PLAN.md");
  git("commit", "-qm", "first");
});

describe("external sources stay unchanged", () => {
  it("survives the full workflow — refresh, summarize, pin, correct, dismiss — byte for byte", async () => {
    const app = await buildServer(paths);
    const before = fingerprint(home);
    spawns.length = 0;
    opened.length = 0;

    // A plain refresh already scans and summarizes: no user action required.
    await app.inject({ method: "POST", url: "/api/refresh" });
    const portfolio = (await (await app.inject({ method: "POST", url: "/api/refresh" })).json()) as {
      active: { id: string }[];
      other: { id: string }[];
      inbox: { id: string }[];
    };
    const id = [...portfolio.active, ...portfolio.other][0]!.id;

    await app.inject({
      method: "POST",
      url: `/api/projects/${id}/override`,
      payload: { pinned: true },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${id}/summary`,
      payload: { recentFocus: "my own words" },
    });
    const refreshed = (await (await app.inject({ method: "POST", url: "/api/refresh" })).json()) as {
      inbox: { id: string }[];
    };
    for (const item of refreshed.inbox) {
      await app.inject({ method: "POST", url: `/api/inbox/${item.id}/dismiss` });
    }

    const restored = (await app.inject({ method: "POST", url: `/api/attention/${refreshed.inbox[0]!.id}/undo` })).json().portfolio as Portfolio;
    expect(restored.inbox).toHaveLength(1);
    const item = restored.inbox[0]!;
    const context = restored.active.find((p) => p.id === item.projectId)!;
    expect(handoff(context, item)).toContain(context.canonicalPath);
    expect((await app.inject({ method: "POST", url: "/api/attention/seen", payload: { ids: [item.id] } })).statusCode).toBe(200);
    for (const action of ["handled", "undo", "tomorrow", "undo", "dismiss"] as const) {
      expect((await app.inject({ method: "POST", url: `/api/attention/${item.id}/${action}` })).statusCode).toBe(200);
    }
    expect(fingerprint(home)).toEqual(before);
    await app.close();
  });

  it("spawns nothing but allow-listed read-only git commands", () => {
    expect(spawns.length).toBeGreaterThan(0);
    const readOnlyVerbs = new Set(["rev-parse", "status", "log", "rev-list"]);
    for (const [file, ...args] of spawns) {
      expect(file).toBe("git");
      expect(args.slice(0, 2)).toEqual(["--no-optional-locks", "--no-pager"]);
      expect(readOnlyVerbs.has(args[2]!)).toBe(true);
    }
  });

  it("never opens a deny-listed file, in the tool state or in the project", () => {
    expect(fs.readFileSync(SECRET, "utf8")).toContain("sk_live");
    expect(opened.length).toBeGreaterThan(0);
    // Sanity: the spy really does capture files the scan reads, so a
    // "was never opened" assertion below cannot pass vacuously.
    expect(openedCanonical()).toContain(canonicalPath(path.join(project, "README.md")));
    expect(openedCanonical()).not.toContain(canonicalPath(SECRET));
    expect(openedCanonical()).not.toContain(canonicalPath(PROJECT_ENV));
    expect(opened.filter(isDeniedPath)).toEqual([]);
  });

  it("never reads inside node_modules", () => {
    expect(openedCanonical().some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("writes generated and corrected information only into its own database", async () => {
    const repo = makeRepo(openDb(appHome));
    const id = repo.projects()[0]!.id;
    expect(repo.summary(id)!.summary).toMatchObject({
      recentFocus: "my own words",
      edited: true,
    });
    expect(repo.override(id).pinned).toBe(true);
    // Our own store is the only thing that changed.
    expect(fs.existsSync(path.join(appHome, "pcc.db"))).toBe(true);
    expect(fs.readdirSync(project).sort()).toEqual([
      ".env",
      ".git",
      "PLAN.md",
      "README.md",
      "node_modules",
    ]);
  });

  it("keeps external state untouched across a second full refresh", async () => {
    const before = fingerprint(home);
    const repo = makeRepo(openDb(appHome));
    await refresh(paths, repo);
    expect(fingerprint(home)).toEqual(before);
  });
});
