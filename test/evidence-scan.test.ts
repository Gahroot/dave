import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { scanProjectEvidence, MAX_FILE_BYTES } from "../src/core/evidence-scan.ts";
import { AT, tempDir, writeText } from "./helpers.ts";

const proj = tempDir("pcc-scan-");

beforeAll(() => {
  writeText(path.join(proj, "README.md"), "# Alpha\n\nA client portal for Acme.\n");
  writeText(path.join(proj, "PLAN.md"), "## Next milestone\n- [ ] Ship the invoice screen\n");
  writeText(path.join(proj, "package.json"), '{"name":"alpha","description":"Client portal"}');
  writeText(path.join(proj, "docs", "scope.md"), "Scope notes");
  // Things that must never be read.
  writeText(path.join(proj, ".env"), "SECRET=hunter2");
  writeText(path.join(proj, ".env.local"), "SECRET=hunter2");
  writeText(path.join(proj, "credentials.json"), '{"token":"sk_live"}');
  writeText(path.join(proj, "node_modules", "dep", "README.md"), "# dependency readme");
  writeText(path.join(proj, "dist", "README.md"), "# build output");
  writeText(path.join(proj, ".git", "README.md"), "# vcs internals");
  writeText(path.join(proj, "ROADMAP.md"), "x".repeat(MAX_FILE_BYTES + 10));
  writeText(path.join(proj, "src", "index.ts"), "console.log(1)");
});

describe("scanProjectEvidence", () => {
  it("reads project documentation and the manifest", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    const names = data.files.map((f) => path.basename(f.path)).sort();
    expect(names).toEqual(["PLAN.md", "README.md", "package.json", "scope.md"]);
  });

  it("never opens dependencies, build output or VCS internals", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    for (const f of data.files) {
      expect(f.path).not.toMatch(/node_modules|[/\\]dist[/\\]|[/\\]\.git[/\\]/);
    }
  });

  it("never opens env files, credentials or other secrets", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    const all = data.files.map((f) => path.basename(f.path));
    for (const secret of [".env", ".env.local", "credentials.json"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("skips oversized files by size, before reading them", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    expect(data.files.some((f) => f.path.endsWith("ROADMAP.md"))).toBe(false);
    const ref = data.refs.find((r) => r.path?.endsWith("ROADMAP.md"));
    expect(ref?.detail).toMatch(/exceeds the read limit/);
  });

  it("ignores unrelated source files", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    expect(data.files.some((f) => f.path.endsWith("index.ts"))).toBe(false);
  });

  it("records a short excerpt as evidence, not the whole file", async () => {
    const { data } = await scanProjectEvidence(proj, AT);
    const readme = data.refs.find((r) => r.path?.endsWith("README.md"))!;
    expect(readme.detail).toBe("Alpha");
    expect(readme.detail.length).toBeLessThan(130);
  });

  it("returns nothing for a directory with no documentation", async () => {
    const { data } = await scanProjectEvidence(tempDir("pcc-empty-"), AT);
    expect(data.files).toEqual([]);
  });
});
