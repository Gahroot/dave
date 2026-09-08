import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourcePaths } from "../src/shared/paths.ts";
import { ezbossLinksDiscovery } from "../src/adapters/discovery-ezboss-links.ts";
import { ezcoderDiscovery } from "../src/adapters/discovery-ezcoder.ts";
import { pew2Discovery } from "../src/adapters/discovery-pew2.ts";
import { canonicalPath } from "../src/core/canonical-path.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

/** Builds a fake home with all three discovery sources pointing at one project. */
function fixtureHome() {
  const home = tempDir("pcc-home-");
  const alpha = path.join(home, "code", "alpha");
  fs.mkdirSync(alpha, { recursive: true });
  const paths = sourcePaths(home, path.join(home, ".pcc"));

  writeJson(paths.ezboss.links, {
    projects: [{ name: "Alpha (boss)", cwd: alpha }, { name: "no-cwd" }],
  });
  writeJson(path.join(paths.ezcoder.taskProjects, "abc123", "meta.json"), {
    path: alpha + path.sep, // trailing separator: must still dedupe
    name: "alpha-ezcoder",
  });
  writeJson(paths.ezcoder.appWorkspace, {
    windows: [{ cwd: path.join(home, "code", "alpha", "..", "alpha") }],
  });
  writeJson(paths.pew2.knownProjects, [alpha, 42]);
  writeText(
    path.join(paths.ezcoder.sessions, "encoded_dir", "2026-01-01T00-00-00Z_a.jsonl"),
    JSON.stringify({ type: "session", cwd: alpha }) + "\n{}\n",
  );
  return { home, alpha, paths };
}

describe("discovery adapters", () => {
  it("finds the same project from every source and dedupes by canonical path", async () => {
    const { alpha, paths } = fixtureHome();
    const all = [
      ...(await ezbossLinksDiscovery(paths).discover()).data,
      ...(await ezcoderDiscovery(paths).discover()).data,
      ...(await pew2Discovery(paths).discover()).data,
    ];
    const canonical = new Set(all.map((p) => canonicalPath(p.rawPath)));
    expect(canonical).toEqual(new Set([canonicalPath(alpha)]));
    expect(new Set(all.map((p) => p.source))).toEqual(
      new Set(["ezboss-links", "ezcoder-tasks", "ezcoder-app", "ezcoder-sessions", "pew2"]),
    );
  });

  it("does not merge different projects that share a display name", async () => {
    const { home, paths } = fixtureHome();
    const beta = path.join(home, "other", "alpha");
    fs.mkdirSync(beta, { recursive: true });
    writeJson(paths.pew2.knownProjects, [beta]);
    const links = (await ezbossLinksDiscovery(paths).discover()).data;
    const pew = (await pew2Discovery(paths).discover()).data;
    expect(canonicalPath(links[0]!.rawPath)).not.toBe(canonicalPath(pew[0]!.rawPath));
  });

  it("reports malformed entries as issues without losing good ones", async () => {
    const { paths } = fixtureHome();
    const links = await ezbossLinksDiscovery(paths).discover();
    expect(links.data).toHaveLength(1);
    expect(links.issues[0]!.message).toMatch(/without a cwd/);

    const pew = await pew2Discovery(paths).discover();
    expect(pew.data).toHaveLength(1);
    expect(pew.issues[0]!.message).toMatch(/non-string entries/);
  });

  it("treats every missing source as empty, not as an error", async () => {
    const paths = sourcePaths(tempDir("pcc-empty-"));
    for (const a of [ezbossLinksDiscovery(paths), ezcoderDiscovery(paths), pew2Discovery(paths)]) {
      const r = await a.discover();
      expect(r.data).toEqual([]);
      expect(r.issues).toEqual([]);
    }
  });

  it("survives corrupt JSON in every source", async () => {
    const { paths } = fixtureHome();
    writeText(paths.ezboss.links, "{broken");
    writeText(paths.pew2.knownProjects, "[1,");
    writeText(paths.ezcoder.appWorkspace, "nope");
    const links = await ezbossLinksDiscovery(paths).discover();
    const pew = await pew2Discovery(paths).discover();
    const ez = await ezcoderDiscovery(paths).discover();
    expect(links.data).toEqual([]);
    expect(links.issues).toHaveLength(1);
    expect(pew.issues).toHaveLength(1);
    expect(ez.issues.some((i) => i.path === paths.ezcoder.appWorkspace)).toBe(true);
    // The task store still produced its project despite the broken workspace file.
    expect(ez.data.some((p) => p.source === "ezcoder-tasks")).toBe(true);
  });

  it("rejects wrong top-level types", async () => {
    const { paths } = fixtureHome();
    writeJson(paths.ezboss.links, { projects: "nope" });
    writeJson(paths.pew2.knownProjects, { a: 1 });
    expect((await ezbossLinksDiscovery(paths).discover()).issues[0]!.message).toMatch(
      /not an array/,
    );
    expect((await pew2Discovery(paths).discover()).issues[0]!.message).toMatch(/not an array/);
  });

  it("prefers the session header cwd over the lossy directory name", async () => {
    const { home, paths } = fixtureHome();
    const weird = path.join(home, "code", "my_app");
    fs.mkdirSync(weird, { recursive: true });
    writeText(
      path.join(paths.ezcoder.sessions, "Users_x_my_app", "2026-01-01T00-00-00Z_b.jsonl"),
      JSON.stringify({ type: "session", cwd: weird }) + "\n",
    );
    const found = await ezcoderDiscovery(paths).discover();
    expect(found.data.map((p) => canonicalPath(p.rawPath))).toContain(canonicalPath(weird));
  });
});
