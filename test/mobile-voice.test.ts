import { describe, expect, it } from "vitest";
import {
  base64UrlToBase64, bytesToBase64, chipLabels, dockHidden, documentSummary, imageDataUri, isTabPath, levelsFromStats, mimeOf,
  phonePageContext, phonePathToWebRoute, unavailableReason, webRouteToPhoneHref,
} from "../mobile/src/features/voice/model.ts";
import type { DocumentMeta } from "../src/voice/types.ts";

// The server's page-context route check (src/server/voice-routes.ts).
const SERVER_ROUTE = /^#?[a-z]*([?/][\w=&%./-]*)?$/i;
const RUN = "0123abcd-0123-4567-89ab-0123456789ab";

describe("phonePathToWebRoute", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["/", {}, "#focus"],
    ["/focus/p1", {}, "#focus?project=p1"],
    ["/queue", {}, "#queue"],
    ["/projects", {}, "#projects"],
    ["/project/p_2", {}, "#projects?id=p_2"],
    ["/delivery/p3", {}, "#projects?id=p3&tab=delivery"],
    ["/meetings", {}, "#meetings"],
    ["/meetings", { section: "asks" }, "#meetings?section=asks"],
    ["/meetings", { section: "bogus" }, "#meetings"],
    ["/meetings/instructions", {}, "#meetings?section=instructions"],
    ["/meetings/12345", {}, "#meetings?rec=12345"],
    ["/agents", {}, "#agents"],
    ["/agents/new", { project: "p1" }, "#agents?view=new&project=p1"],
    ["/agents/settings", {}, "#agents?view=settings"],
    [`/agents/${RUN}`, {}, `#agents/${RUN}`],
    ["/cleanup", { bucket: "looks_done" }, "#cleanup?bucket=looks_done"],
    ["/cleanup", { bucket: "nope" }, "#cleanup"],
    ["/connections", {}, "#connections"],
    ["/issues", {}, "#issues"],
    ["/voice", {}, "#voice"],
    ["/more", {}, "#focus"],
    ["/settings", {}, "#focus"],
    ["/project/bad id!", {}, "#projects"],
  ];
  it.each(cases)("%s %j → %s", (path, params, hash) => {
    expect(phonePathToWebRoute(path, params)).toBe(hash);
    expect(SERVER_ROUTE.test(hash)).toBe(true);
  });
  it("ignores group segments and array params", () => {
    expect(phonePathToWebRoute("/(tabs)/queue")).toBe("#queue");
    expect(phonePathToWebRoute("/meetings", { section: ["list", "asks"] })).toBe("#meetings?section=list");
  });
});

describe("phonePageContext", () => {
  it("names the destination and project like the web", () => {
    expect(phonePageContext("/focus/p1")).toEqual({ route: "focus", projectId: "p1" });
    expect(phonePageContext("/project/p2")).toEqual({ route: "projects", projectId: "p2" });
    expect(phonePageContext("/meetings/42")).toEqual({ route: "meetings", projectId: null });
    expect(phonePageContext("/more")).toEqual({ route: "focus", projectId: null });
  });
});

describe("webRouteToPhoneHref", () => {
  const cases: [string, string | null][] = [
    ["#focus", "/(tabs)"],
    ["#focus?project=p1", "/focus/p1"],
    ["#queue?item=x", "/(tabs)/queue"],
    ["#projects", "/(tabs)/projects"],
    ["#projects?id=p2&tab=delivery", "/project/p2"],
    ["#meetings", "/(tabs)/meetings"],
    ["#meetings?section=asks", "/(tabs)/meetings?section=asks"],
    ["#meetings?rec=777", "/meetings/777"],
    ["#agents", "/agents"],
    [`#agents/${RUN}`, `/agents/${RUN}`],
    ["#agents?view=new&project=p1", "/agents/new?project=p1"],
    ["#agents?view=settings", "/agents/settings"],
    ["#cleanup?bucket=old_asks", "/cleanup?bucket=old_asks"],
    ["#cleanup", "/cleanup"],
    ["#connections", "/connections"],
    ["#issues", "/issues"],
    ["#voice", "/voice"],
    ["#nowhere", null],
    ["https://evil.example", null],
    ["focus", null],
  ];
  it.each(cases)("%s → %s", (hash, href) => expect(webRouteToPhoneHref(hash)).toBe(href));

  it("round-trips the phone's own screens", () => {
    for (const path of ["/focus/p1", "/project/p2", `/agents/${RUN}`, "/meetings/12", "/connections", "/issues", "/voice"]) {
      expect(webRouteToPhoneHref(phonePathToWebRoute(path))).toBe(path);
    }
  });
});

describe("dock placement", () => {
  it("hides on voice and pairing, floats above tabs", () => {
    expect(dockHidden("/voice")).toBe(true);
    expect(dockHidden("/pair")).toBe(true);
    expect(dockHidden("/")).toBe(false);
    expect(isTabPath("/")).toBe(true);
    expect(isTabPath("/meetings")).toBe(true);
    expect(isTabPath("/meetings/12")).toBe(false);
  });
});

describe("levelsFromStats", () => {
  it("reads mic from media-source and DAVE from inbound-rtp", () => {
    expect(levelsFromStats([
      { type: "media-source", kind: "audio", audioLevel: 0.25 },
      { type: "inbound-rtp", kind: "audio", audioLevel: 0.5 },
      { type: "inbound-rtp", kind: "video", audioLevel: 0.9 },
      { type: "candidate-pair" },
    ])).toEqual({ input: 0.25, output: 0.5 });
  });
  it("falls back to legacy track stats and clamps", () => {
    expect(levelsFromStats([
      { type: "track", kind: "audio", remoteSource: true, audioLevel: 3 },
      { type: "track", kind: "audio", remoteSource: false, audioLevel: 0.1 },
    ])).toEqual({ input: 0.1, output: 1 });
    expect(levelsFromStats([])).toEqual({ input: 0, output: 0 });
    expect(levelsFromStats([null, "x", { type: "inbound-rtp", kind: "audio", audioLevel: Number.NaN }])).toEqual({ input: 0, output: 0 });
  });
});

describe("bytes and display", () => {
  it("encodes base64 like Buffer", () => {
    for (const s of ["", "a", "ab", "abc", "hello world!", "\u00ff\u00fe"]) {
      const bytes = new TextEncoder().encode(s);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
    expect(base64UrlToBase64("-_8")).toBe("+/8=");
  });
  it("builds image data URIs only for images", () => {
    expect(imageDataUri({ base64url: "AQ", contentType: "image/png" })).toBe("data:image/png;base64,AQ==");
    expect(imageDataUri({ base64url: "AQ", contentType: "application/pdf" })).toBeNull();
  });
  it("guesses MIME types", () => {
    expect(mimeOf("a.PDF")).toBe("application/pdf");
    expect(mimeOf("a.jpg")).toBe("image/jpeg");
    expect(mimeOf("a.bin", "Image/PNG")).toBe("image/png");
    expect(mimeOf("noext")).toBe("application/octet-stream");
  });
  it("summarises documents like the web card", () => {
    const doc = { id: "d1", name: "x.pdf", kind: "pdf", size: 1, pages: 2, textState: "ready", projectId: null, projectName: null, createdAt: "", textChars: 0, agreementCandidates: 0 } satisfies DocumentMeta;
    expect(documentSummary(doc, false)).toBe("PDF · 2 pages · text read");
    expect(documentSummary({ ...doc, kind: "image", pages: null, textState: "pending" }, true)).toBe("IMAGE · reading text… · image sent");
  });
  it("labels chips and reasons", () => {
    expect(chipLabels({ decisions: 1, noFinishLine: 2 }, "Alpha").map((c) => c.text)).toEqual(["1 decision waiting", "2 without a finish line", "Looking at: Alpha"]);
    expect(unavailableReason({ reason: "not_connected" })).toBe("not_connected");
    expect(unavailableReason({ reason: "token leaked" })).toBeNull();
  });
});
