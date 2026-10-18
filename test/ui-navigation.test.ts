import { describe, expect, it } from "vitest";
import { parseRoute, routeLink, safeReturn } from "../src/ui/navigation.ts";

describe("workspace navigation", () => {
  it("opens Clean up with a validated bucket and allows it as a return target", () => {
    expect(parseRoute("#cleanup")).toMatchObject({ destination: "cleanup", bucket: null });
    expect(parseRoute(routeLink("cleanup", { bucket: "meeting_decisions" }))).toMatchObject({ destination: "cleanup", bucket: "meeting_decisions" });
    expect(parseRoute("#cleanup?bucket=everything").bucket).toBeNull();
    expect(parseRoute("#meetings?bucket=old_asks").bucket).toBeNull();
    expect(safeReturn("#cleanup?bucket=old_asks&prompt=private")).toBe("#cleanup?bucket=old_asks");
  });
  it("preserves legacy queue, project and handoff links", () => {
    expect(parseRoute("#queue?item=req-1&delivery=project-1")).toMatchObject({ destination: "queue", item: "req-1", delivery: "project-1" });
    expect(parseRoute("#projects?id=one&q=a%20b&waiting=1")).toMatchObject({ id: "one", q: "a b", waiting: true, tab: "delivery" });
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
    expect(parseRoute("#projects?tab=secret&filter=unknown")).toMatchObject({ tab: "delivery", filter: "all" });
  });
  it("accepts only known internal return destinations and strips private/recursive fields", () => {
    for (const value of ["https://example.org", "//example.org", "javascript:alert(1)", "#connections", "#agents/invalid"]) expect(safeReturn(value)).toBeNull();
    expect(safeReturn("#queue?item=abc&prompt=private&return=%23projects")).toBe("#queue?item=abc");
    expect(parseRoute("#connections?return=%23projects%3Fid%3Da%26tab%3Ddelivery").returnTo).toBe("#projects?id=a&tab=delivery");
  });
  it("defaults to Work while preserving explicit legacy Reference links", () => {
    expect(parseRoute("#projects?id=one").tab).toBe("delivery");
    for (const tab of ["overview", "context", "delivery"]) expect(parseRoute(`#projects?id=one&tab=${tab}`).tab).toBe(tab);
  });
  it("bounds inbox pages and preserves them in safe returns", () => {
    for (const value of ["0", "-1", "1.5", "Infinity", "10000", "private"]) expect(parseRoute(`#queue?page=${value}`).page).toBe(1);
    expect(parseRoute("#queue?page=9999").page).toBe(1000);
    expect(safeReturn("#queue?filter=waiting&page=3&prompt=private")).toBe("#queue?filter=waiting&page=3");
    expect(safeReturn("#queue?page=-2")).toBe("#queue");
  });
  it("validates meetings sections and recording ids, and allows them as return targets", () => {
    expect(parseRoute("#meetings")).toMatchObject({ destination: "meetings", section: "promises", rec: null, invalidSelection: false });
    expect(parseRoute(routeLink("meetings", { section: "list", rec: "123456789" }))).toMatchObject({ section: "list", rec: "123456789" });
    expect(parseRoute("#meetings?section=bogus").section).toBe("promises");
    for (const bad of ["12a", "../1", "1".repeat(21), ""]) {
      expect(parseRoute(`#meetings?rec=${bad}`)).toMatchObject({ rec: null, invalidSelection: true });
    }
    // Recording ids only mean something on the meetings page.
    expect(parseRoute("#projects?rec=123").rec).toBeNull();
    expect(safeReturn("#meetings?section=asks&rec=42&secret=1")).toBe("#meetings?section=asks&rec=42");
    expect(safeReturn("#meetings?rec=4x")).toBeNull();
    expect(safeReturn("#meetings")).toBe("#meetings");
  });
  it("carries only a well-formed meeting item into the assignment composer", () => {
    const id = "mi-0123456789abcdef01234567";
    expect(parseRoute(routeLink("agents", { view: "new", project: "p1", meetingItem: id }))).toMatchObject({ view: "new", project: "p1", meetingItem: id });
    for (const value of ["mi-XYZ", "mi-0123", `${id}0`, "../mi-0123456789abcdef01234567", "%3Cscript%3E"]) {
      expect(parseRoute(`#agents?view=new&meetingItem=${value}`).meetingItem).toBeNull();
    }
    expect(safeReturn(`#agents?view=new&project=p1&meetingItem=${id}&prompt=private`)).toBe(`#agents?view=new&project=p1&meetingItem=${id}&filter=all`);
    expect(safeReturn("#agents?view=new&meetingItem=bad")).toBe("#agents?view=new&filter=all");
  });
  it("round-trips search and validated tabs", () => {
    const route = parseRoute(routeLink("projects", { id: "abc", q: "name & path", tab: "context", waiting: true }));
    expect(route).toMatchObject({ id: "abc", q: "name & path", tab: "context", waiting: true });
    expect(parseRoute("").destination).toBe("focus");
    expect(parseRoute("#nonsense").destination).toBe("focus");
    expect(parseRoute("#queue").destination).toBe("queue");
    expect(parseRoute("#agents").destination).toBe("agents");
    expect(parseRoute("#focus?project=abc_1")).toMatchObject({ destination: "focus", project: "abc_1", invalidSelection: false });
    expect(parseRoute("#focus?project=../x").invalidSelection).toBe(true);
    expect(parseRoute("#focus?project=../x").project).toBeNull();
  });
  it("adds the voice destination without widening safe returns", () => {
    expect(parseRoute("#voice").destination).toBe("voice");
    expect(parseRoute("#voice?project=p1")).toMatchObject({ destination: "voice", invalidSelection: false });
    expect(routeLink("voice")).toBe("#voice");
    expect(safeReturn("#voice")).toBeNull();
    expect(safeReturn("#focus?project=p1")).toBe("#focus?project=p1");
  });
});
