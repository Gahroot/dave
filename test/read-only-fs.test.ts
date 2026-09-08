import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeniedPathError, readOnlyFs } from "../src/adapters/read-only-fs.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-rofs-"));
fs.writeFileSync(path.join(tmp, "ok.json"), '{"a":1}');
fs.writeFileSync(path.join(tmp, "bad.json"), "{not json");
fs.writeFileSync(path.join(tmp, "projects.json"), '{"key":"sk_live_secret"}');
fs.writeFileSync(path.join(tmp, ".env"), "TOKEN=1");

describe("readOnlyFs", () => {
  it("reads JSON", async () => {
    expect(await readOnlyFs.readJson(path.join(tmp, "ok.json"))).toEqual({ a: 1 });
  });

  it("returns null for a missing file", async () => {
    expect(await readOnlyFs.readJson(path.join(tmp, "nope.json"))).toBeNull();
  });

  it("throws on corrupt JSON so the caller can log an issue", async () => {
    await expect(readOnlyFs.readJson(path.join(tmp, "bad.json"))).rejects.toThrow();
  });

  it("refuses deny-listed secret files", async () => {
    for (const f of ["projects.json", ".env"]) {
      await expect(readOnlyFs.readText(path.join(tmp, f))).rejects.toBeInstanceOf(
        DeniedPathError,
      );
    }
  });

  it("returns [] for a missing directory", async () => {
    expect(await readOnlyFs.readdir(path.join(tmp, "nope"))).toEqual([]);
  });

  it("stats files and returns null when absent", async () => {
    expect((await readOnlyFs.stat(path.join(tmp, "ok.json")))?.isFile()).toBe(true);
    expect(await readOnlyFs.stat(path.join(tmp, "nope"))).toBeNull();
  });

  it("exposes no mutating operations", () => {
    for (const banned of ["writeFile", "unlink", "mkdir", "rm", "rename"]) {
      expect(banned in readOnlyFs).toBe(false);
    }
  });
});
