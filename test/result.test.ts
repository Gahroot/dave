import { describe, expect, it } from "vitest";
import { issue, ok, safeAsync } from "../src/core/result.ts";

describe("result", () => {
  it("wraps data with no issues by default", () => {
    expect(ok(1)).toEqual({ data: 1, issues: [] });
  });

  it("converts a throw into an issue plus the fallback", async () => {
    const r = await safeAsync("x", [], () => {
      throw new Error("boom");
    }, "/p");
    expect(r.data).toEqual([]);
    expect(r.issues[0]).toMatchObject({ adapter: "x", message: "boom", path: "/p" });
  });

  it("passes through successful results", async () => {
    const r = await safeAsync("x", 0, () => ok(5, [issue("x", "warn")]));
    expect(r.data).toBe(5);
    expect(r.issues).toHaveLength(1);
  });
});
