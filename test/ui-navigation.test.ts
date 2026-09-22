import { describe, expect, it } from "vitest";
import { parseRoute, routeLink, safeReturn } from "../src/ui/navigation.ts";

describe("workspace navigation", () => {
  it("preserves legacy queue, project and handoff links", () => {
    expect(parseRoute("#queue?item=req-1&delivery=project-1")).toMatchObject({ destination: "queue", item: "req-1", delivery: "project-1" });
    expect(parseRoute("#projects?id=one&q=a%20b&waiting=1")).toMatchObject({ id: "one", q: "a b", waiting: true, tab: "overview" });
    expect(parseRoute("#agents?project=one&handoff=two")).toMatchObject({ project: "one", handoff: "two" });
    expect(parseRoute("#issues").destination).toBe("issues");
  });
  it("keeps run selection with query state", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(parseRoute(routeLink("agents", { filter: "attention" }, id))).toMatchObject({ runId: id, runFilter: "attention" });
  });
  it("rejects invalid identifiers without choosing another record", () => {
    expect(parseRoute("#agents/not-a-run")).toMatchObject({ runId: null, invalidRun: true });
    expect(parseRoute("#projects?id=%2Fetc%2Fpasswd")).toMatchObject({ id: null, invalidSelection: true });
    expect(parseRoute("#projects?tab=secret&filter=unknown")).toMatchObject({ tab: "overview", filter: "all" });
  });
  it("accepts only known internal return destinations and strips private/recursive fields", () => {
    for (const value of ["https://example.org", "//example.org", "javascript:alert(1)", "#connections", "#agents/invalid"]) expect(safeReturn(value)).toBeNull();
    expect(safeReturn("#queue?item=abc&prompt=private&return=%23projects")).toBe("#queue?item=abc");
    expect(parseRoute("#connections?return=%23projects%3Fid%3Da%26tab%3Ddelivery").returnTo).toBe("#projects?id=a&tab=delivery");
  });
  it("round-trips search and validated tabs", () => {
    const route = parseRoute(routeLink("projects", { id: "abc", q: "name & path", tab: "context", waiting: true }));
    expect(route).toMatchObject({ id: "abc", q: "name & path", tab: "context", waiting: true });
    expect(parseRoute("").destination).toBe("queue");
  });
});
