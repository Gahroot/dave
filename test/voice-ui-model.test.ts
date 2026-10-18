import { describe, expect, it } from "vitest";
import type { FocusState } from "../src/intel/types.ts";
import { LIMITS, type DocumentMeta } from "../src/voice/types.ts";
import { appendCard, appendLine, approvalAnnouncement, approvalNote, cardsFromToolResponse, offerApprovalCard, openConfirmIds, contextNote, documentTextNote, downscalePlan, focusChips, focusUpdateNote, imageSendable, isTypingTarget, matchShortcut, pageContext, sharedNote, transcriptOf, updateCard, type TimelineEntry } from "../src/ui/voice/model.ts";

const focus = (top: string | null, decisions: string[], outcomes: (string | null)[] = []) => ({
  top: top ? { id: top, objective: `Ship ${top}`, projectName: "Acme" } : null,
  decisions: decisions.map(id => ({ id, summary: `Decide ${id}`, projectName: "Acme" })),
  projects: outcomes.map((outcome, i) => ({ projectId: `p${i}`, projectName: `P${i}`, outcome })),
}) as unknown as FocusState;
const key = (over: Partial<Parameters<typeof matchShortcut>[0]>) => ({ key: "", code: "", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...over });
const doc: DocumentMeta = { id: "d1", name: "Brief.pdf", kind: "pdf", size: 10, pages: 3, textState: "ready", projectId: "p1", projectName: "Acme", createdAt: "", textChars: 5, agreementCandidates: 0 };

describe("voice ui model", () => {
  it("caps transcript lines and characters and merges duplicates", () => {
    let entries: TimelineEntry[] = [];
    for (let i = 0; i < LIMITS.transcriptLines + 5; i++) entries = appendLine(entries, "user", `line ${i}`, "t", `id${i}`);
    expect(entries).toHaveLength(LIMITS.transcriptLines);
    expect(transcriptOf(entries)[0]?.text).toBe("line 5");
    const long = appendLine([], "assistant", "x".repeat(LIMITS.transcriptLineChars + 50), "t", "a");
    expect(transcriptOf(long)[0]?.text.length).toBe(LIMITS.transcriptLineChars);
    expect(appendLine(appendLine([], "user", "hi", "t", "1"), "user", "hi", "t", "2")).toHaveLength(1);
    expect(appendLine([], "user", "   ", "t", "1")).toHaveLength(0);
  });
  it("keeps the posted transcript inside the guarded JSON body limit, newest lines first", () => {
    let entries: TimelineEntry[] = [];
    const at = "2026-10-18T10:00:00.000Z";
    for (let i = 0; i < LIMITS.transcriptLines; i++) entries = appendLine(entries, i % 2 ? "assistant" : "user", `${i} ${"é".repeat(LIMITS.transcriptLineChars)}`, at, `id${i}`);
    const posted = transcriptOf(entries);
    const body = JSON.stringify({ reason: "user", transcript: posted });
    expect(new TextEncoder().encode(body).length).toBeLessThan(64 * 1024);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.at(-1)?.text.startsWith(`${LIMITS.transcriptLines - 1} `)).toBe(true);
  });
  it("builds cards from tool responses and updates them", () => {
    const cards = cardsFromToolResponse("c1", { ok: true, output: "{}", card: { tone: "green", title: "Saved" }, confirm: { token: "tk", title: "Set priority", say: "Okay?", details: [], expiresAt: "" }, ui: { copy: { label: "Tasks", text: "do it", projectId: "p1", itemIds: ["i1"] } } });
    // The confirm card carries the title and wording itself, so the matching action card is not shown twice.
    expect(cards.map(c => c.kind)).toEqual(["confirm", "copy"]);
    expect(cardsFromToolResponse("c3", { ok: true, output: "{}", card: { tone: "green", title: "Saved" } }).map(c => c.kind)).toEqual(["action"]);
    expect(cardsFromToolResponse("c2", { ok: true, output: "{}" })).toEqual([]);
    const first = cards[0];
    if (!first) throw new Error("missing");
    const entries = updateCard(appendCard([], first), first.id, c => c.kind === "confirm" ? { ...c, state: "accepted" } : c);
    expect(entries[0]).toMatchObject({ kind: "card", card: { state: "accepted" } });
    expect(transcriptOf(entries)).toEqual([]);
  });
  it("writes [Shared], [Context] and [Update] notes", () => {
    expect(sharedNote(doc, true)).toMatch(/^\[Shared\] .*"Brief\.pdf" \(pdf, 3 pages, text ready\)\. Document id: d1\..*image itself/);
    expect(documentTextNote({ ...doc, textState: "pending" })).toBeNull();
    expect(documentTextNote(doc)).toMatch(/^\[Update\] The text of "Brief\.pdf" is ready \(document id d1\)/);
    expect(documentTextNote({ ...doc, textState: "unavailable" })).toMatch(/^\[Update\] DAVE could not read text from "Brief\.pdf"/);
    expect(contextNote({ route: "focus", projectId: "p1" }, "Acme")).toBe("[Context] The user is now looking at the focus page. Project: \"Acme\" (id p1). Do not reply to this note.");
    expect(contextNote({ route: "meetings", projectId: null }, null)).toContain("No project is selected");
    expect(pageContext("#focus?project=p1")).toEqual({ route: "focus", projectId: "p1" });
    expect(pageContext("#projects?id=p2")).toEqual({ route: "projects", projectId: "p2" });
    expect(pageContext("#voice")).toEqual({ route: "voice", projectId: null });
  });
  it("diffs focus into update notes", () => {
    expect(focusUpdateNote(null, focus("o1", ["d1"]))).toBeNull();
    expect(focusUpdateNote(focus("o1", ["d1"]), focus("o1", ["d1"]))).toBeNull();
    const note = focusUpdateNote(focus("o1", ["d1"]), focus("o2", ["d1", "d2"]));
    expect(note).toContain("[Update] New top objective: \"Ship o2\"");
    expect(note).toContain("1 new decision waiting: \"Decide d2\" (Acme)");
    expect(focusChips(focus(null, ["a", "b"], ["x", null, null]))).toEqual({ decisions: 2, noFinishLine: 2 });
  });
  it("plans image downscale and skips large data URLs", () => {
    expect(downscalePlan(4000, 2000)).toEqual({ width: 1024, height: 512, type: "image/jpeg", quality: 0.8 });
    expect(downscalePlan(800, 600)).toMatchObject({ width: 800, height: 600 });
    expect(downscalePlan(0, 10)).toBeNull();
    expect(imageSendable(`data:image/jpeg;base64,${"A".repeat(100)}`)).toBe(true);
    expect(imageSendable(`data:image/jpeg;base64,${"A".repeat(LIMITS.imageDataUrlChars)}`)).toBe(false);
    expect(imageSendable("data:text/plain,hi")).toBe(false);
  });
  it("matches shortcuts", () => {
    const ctx = { panelFocused: true, mode: "push_to_talk" as const, typing: false };
    expect(matchShortcut(key({ code: "KeyD", key: "Î", altKey: true, shiftKey: true }), ctx)).toBe("toggle");
    expect(matchShortcut(key({ code: "KeyD", key: "d", altKey: true }), ctx)).toBeNull();
    expect(matchShortcut(key({ code: "Space", key: " " }), ctx)).toBe("push_to_talk");
    expect(matchShortcut(key({ code: "Space", key: " " }), { ...ctx, typing: true })).toBeNull();
    expect(matchShortcut(key({ code: "Space", key: " " }), { ...ctx, panelFocused: false })).toBeNull();
    expect(matchShortcut(key({ code: "Space", key: " " }), { ...ctx, mode: "hands_free" })).toBeNull();
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  });
  it("approve all helpers: note text, accept order, offer card and undo cards", () => {
    expect(approvalNote(true)).toBe("[Update] The user turned on Approve all for this session. Write tools now apply immediately; do not ask before changes.");
    expect(approvalNote(false)).toMatch(/^\[Update\] The user turned off Approve all/);
    expect(approvalAnnouncement(true)).toBe("Approve all is on: DAVE makes changes without asking until this conversation ends");
    const c = (token: string) => ({ token, title: token, say: "", details: [], expiresAt: "" });
    let entries: TimelineEntry[] = [];
    for (const t of ["a", "b", "c"]) entries = appendCard(entries, { kind: "confirm", id: t, confirm: c(t), state: "open" });
    entries = appendLine(entries, "user", "hi", "t", "l1");
    entries = updateCard(entries, "b", x => x.kind === "confirm" ? { ...x, state: "declined" } : x);
    expect(openConfirmIds(entries)).toEqual(["a", "c"]);
    expect(offerApprovalCard("c9")).toEqual({ kind: "approval", id: "c9:approval", state: "open" });
    const offered = cardsFromToolResponse("c9", { ok: false, output: "{}", card: { tone: "amber", title: "Needs you" }, ui: { offerApproval: true } });
    expect(offered.map(x => x.kind)).toEqual(["action", "approval"]);
    const undo = cardsFromToolResponse("c10", { ok: true, output: "{}", card: { tone: "green", title: "Clear 3 items" }, ui: { undo: { batchId: "tb-1" } } });
    expect(undo[0]).toMatchObject({ kind: "action", undo: { batchId: "tb-1", state: "ready" } });
  });
});
