import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, pathExists } from "../src/core/canonical-path.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-canon-"));
const real = path.join(tmp, "real");
fs.mkdirSync(path.join(real, "nested"), { recursive: true });
const link = path.join(tmp, "link");
fs.symlinkSync(real, link);

describe("canonicalPath", () => {
  it("resolves symlinks to the real directory", () => {
    expect(canonicalPath(link)).toBe(canonicalPath(real));
  });

  it("strips trailing separators", () => {
    expect(canonicalPath(real + path.sep)).toBe(canonicalPath(real));
  });

  it("resolves .. segments", () => {
    expect(canonicalPath(path.join(real, "nested", ".."))).toBe(canonicalPath(real));
  });

  it("folds case on darwin/win32", () => {
    const folded = canonicalPath(real.toUpperCase());
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(folded).toBe(canonicalPath(real));
    } else {
      expect(folded).not.toBe(canonicalPath(real));
    }
  });

  it("expands a leading ~", () => {
    expect(canonicalPath("~/x")).toBe(canonicalPath(path.join(os.homedir(), "x")));
  });

  it("canonicalizes a non-existent path without throwing", () => {
    const ghost = path.join(tmp, "ghost", "..", "ghost");
    expect(canonicalPath(ghost)).toBe(canonicalPath(path.join(tmp, "ghost")));
    expect(pathExists(ghost)).toBe(false);
  });

  it("reports existing directories", () => {
    expect(pathExists(real)).toBe(true);
    expect(pathExists(path.join(tmp, "nope"))).toBe(false);
  });
});
