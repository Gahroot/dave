import { afterEach, describe, expect, it } from "vitest";
import { intelHarness } from "./intel-fixture.ts";
import { createToolExecutor, VOICE_TOOLS, type PreparedAction } from "../src/voice/tools.ts";
import { confirmStore } from "../src/voice/confirm.ts";
import { voiceStore } from "../src/voice/store.ts";
import type { VoiceIntel, VoiceMeetings, VoicePortfolio } from "../src/voice/deps.ts";
import type { DirectionApi, DirectionNote, ProjectDirection } from "../src/intel/types.ts";
import type { DocumentService } from "../src/documents/types.ts";
import type { DocumentMeta, ToolCallResponse } from "../src/voice/types.ts";
import type { MeetingItem } from "../src/meetings/types.ts";
import type { Portfolio } from "../src/shared/types.ts";
import type { VoiceTriage } from "../src/voice/deps.ts";
import { TRIAGE_BUCKETS, type TriageBatch, type TriageEntry, type TriageBucket } from "../src/triage/types.ts";

const entry = (n: number, bucket: TriageBucket = "overdue_promises"): TriageEntry => ({
  key: `m:mi-${String(n).padStart(24, "0")}`, kind: "promise", bucket, title: `Promise ${n}`, projectId: "p1", projectName: "Acme",
  dueDate: "2026-09-01", meetingAt: null, meetingTitle: "Call", reasons: [`Due 1 Sep, reason ${n}`], confirmed: false,
});
function fakeTriage() {
  const state = { entries: [] as TriageEntry[], applied: [] as { keys: readonly string[]; action: string; source: string }[], batches: [] as TriageBatch[], undone: [] as string[] };
  const triage: VoiceTriage = {
    preview: (filter = {}) => {
      const entries = state.entries.filter((e) => (!filter.keys || filter.keys.includes(e.key)) && (!filter.buckets || filter.buckets.includes(e.bucket)) && (!filter.projectId || e.projectId === filter.projectId));
      const counts = Object.fromEntries(TRIAGE_BUCKETS.map((b) => [b, entries.filter((e) => e.bucket === b).length])) as Record<TriageBucket, number>;
      return { generatedAt: "x", entries, counts, total: entries.length, confirmedHidden: 0 };
    },
    apply: (req) => {
      state.applied.push(req);
      const id = `tb-${String(state.batches.length + 1).padStart(24, "0")}`;
      state.batches.unshift({ id, createdAt: "x", source: req.source, action: req.action, summary: `Cleared ${req.keys.length} items.`, count: req.keys.length, undoneAt: null });
      return { batchId: id, changed: req.keys.length, skipped: [], kept: [], summary: `Cleared ${req.keys.length} items.` };
    },
    undo: (id) => { state.undone.push(id); const b = state.batches.find((x) => x.id === id); if (!b) return null; b.undoneAt = "y"; return { restored: b.count, skipped: 0 }; },
    batches: (limit = 20) => state.batches.slice(0, limit),
  };
  return { state, triage };
}

const harnesses: ReturnType<typeof intelHarness>[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.close(); });

function fakeDirection(): DirectionApi & { dirs: Map<string, ProjectDirection>; notes: DirectionNote[] } {
  const dirs = new Map<string, ProjectDirection>();
  const notes: DirectionNote[] = [];
  const get = (id: string): ProjectDirection => dirs.get(id) ?? { projectId: id, paidWhen: null, priority: null, focusItemIds: [], notes: [], updatedAt: null };
  return {
    dirs, notes,
    direction: get,
    setDirection(id, patch) { dirs.set(id, { ...get(id), ...patch, updatedAt: "2026-10-12T09:00:00.000Z" }); return {} as never; },
    addDirectionNote(projectId, text, source) { const n = { id: `n${notes.length + 1}`, projectId, text, source, createdAt: "2026-10-12T09:00:00.000Z" }; notes.unshift(n); return n; },
    deleteDirectionNote(id) { const i = notes.findIndex((n) => n.id === id); if (i >= 0) notes.splice(i, 1); },
    directionNotes(_p, limit) { return notes.slice(0, limit); },
  };
}

const doc: DocumentMeta = { id: "d1", name: "Acme contract.pdf", kind: "pdf", size: 10, pages: 2, textState: "ready", projectId: null, projectName: null, createdAt: "2026-10-12T09:00:00.000Z", textChars: 100, agreementCandidates: 2 };
function fakeDocuments(): DocumentService & { attached: (string | null)[] } {
  const attached: (string | null)[] = [];
  return {
    attached,
    upload: async () => { throw new Error("unused"); },
    list: () => [doc], get: (id) => id === "d1" ? doc : null, settled: async () => doc,
    read: (id) => id === "d1" ? { document: doc, text: "Deliver booking. key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX at /Users/me/secret/file.txt", page: null, pages: 2, offset: 0, nextOffset: null } : null,
    agreement: () => ({ items: [{ title: "Booking flow", detail: null, section: null }, { title: "Admin panel", detail: null, section: null }], acceptance: ["Client books online"] }),
    content: () => null, setProject: (_id, p) => { attached.push(p); return { ...doc, projectId: p }; }, remove: () => true, close: async () => undefined,
  };
}

const meetingItem = { id: "mi-000000000000000000000001", recordingId: "1", kind: "commitment", text: "Send the invoice draft", quote: "SECRET VERBATIM QUOTE", atSeconds: 1, speaker: "Me", speakerRole: "me",
  projectId: "p1", projectName: "Acme", projectSource: "user", duePhrase: null, dueDate: "2026-10-20", feature: null, status: "open", suggestedStatus: null, statusSource: "model",
  statusNote: null, statusChangedAt: null, edited: false, agentRunId: null, createdAt: "x", updatedAt: "x", meetingTitle: "Call" } as unknown as MeetingItem;

function setup() {
  const h = intelHarness([{ id: "p1", name: "Acme" }, { id: "p2", name: "Acme Mobile" }, { id: "p3", name: "Beta" }]);
  harnesses.push(h);
  let clock = new Date("2026-10-12T09:00:00.000Z");
  const now = () => clock;
  const dir = fakeDirection();
  const intel: VoiceIntel = { ...h.intel, ...dir };
  const statusCalls: string[] = [];
  const meetings: VoiceMeetings = { items: () => [meetingItem], setItemStatus: (_id, a) => { statusCalls.push(String(a)); return meetingItem; }, syncNow: () => undefined, fathomConnected: () => false };
  const pf: Portfolio = { generatedAt: "x", active: [], other: [], hidden: [], today: [], inbox: [], issues: [] };
  const portfolio: VoicePortfolio = { refresh: async () => pf, current: async () => pf, attention: () => pf, override: () => true };
  const documents = fakeDocuments();
  const store = voiceStore(h.db, now);
  const confirms = confirmStore<PreparedAction>(now);
  const tri = fakeTriage();
  const exec = createToolExecutor({ intel, meetings, portfolio, documents, projects: () => h.state.projects.map((p) => ({ id: p.id, name: p.name })), triage: tri.triage, store, confirms, now });
  let n = 0;
  const batches: string[] = [];
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = "s1", projectId: string | null = null, autoApprove = false) => exec.execute({ sessionId, projectId, autoApprove, batches }, { callId: `c${++n}`, name, args });
  const out = (r: ToolCallResponse) => JSON.parse(r.output) as Record<string, unknown>;
  return { h, db: h.db, tri, batches, dir, documents, exec, call, out, statusCalls, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("voice tools", () => {
  it("defines the agreed tool list, nothing dangerous", () => {
    const names = VOICE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(42);
    for (const added of ["approve_session", "find_noise", "clean_up", "undo_clean_up"]) expect(names).toContain(added);
    for (const banned of ["launch_agent", "disconnect_openai", "connect_openai", "hide_project", "fathom_key", "agent_desk"]) expect(names).not.toContain(banned);
  });

  it("read tools return cards and plain output", async () => {
    const f = setup();
    for (const name of ["portfolio_overview", "alignment_check", "list_projects", "whats_next", "list_decisions", "inbox", "recent_changes", "diagnostics", "list_documents", "voice_history"]) {
      const r = await f.call(name);
      expect(r.ok, name).toBe(true);
      expect(r.card, name).toBeTruthy();
    }
    const d = await f.call("project_details", { project: "beta" });
    expect(f.out(d)).toMatchObject({ projectId: "p3", name: "Beta", finishLine: null });
  });

  it("asks which project when ambiguous", async () => {
    const f = setup();
    const r = await f.call("project_details", { project: "acm" });
    expect(r.ok).toBe(false);
    expect(f.out(r)).toMatchObject({ ambiguous: true, candidates: ["Acme", "Acme Mobile"] });
  });

  it("never includes meeting quotes and redacts document text", async () => {
    const f = setup();
    const m = await f.call("meeting_promises");
    expect(m.output).toContain("Send the invoice draft");
    expect(m.output).not.toContain("SECRET VERBATIM QUOTE");
    const d = await f.call("read_document", { document: "acme contract" });
    expect(d.output).not.toContain("sk-proj");
    expect(d.output).not.toContain("/Users/me");
    const fl = await f.call("finish_line_from_document", { document: "d1" });
    expect(f.out(fl).deliverables).toEqual(["Booking flow", "Admin panel"]);
  });

  it("confirm flow: prepare, then the stored action runs once", async () => {
    const f = setup();
    const p = await f.call("set_finish_line", { project: "Beta", finishLine: "Clients book online", acceptance: ["Booking works", "Email sent"], paidWhen: "client signs off" });
    const o = f.out(p);
    expect(o.needsConfirmation).toBe(true);
    expect(p.confirm?.token).toBe(o.confirmToken);
    expect(p.card?.tone).toBe("amber");
    expect(f.h.intel.projectIntel("p3").outcome).toBeNull();
    // Re-sent args are ignored: the stored action runs.
    const yes = await f.call("set_finish_line", { confirmToken: o.confirmToken, userConfirmed: true, finishLine: "SOMETHING ELSE" });
    expect(yes.ok).toBe(true);
    expect(yes.card?.tone).toBe("green");
    expect(yes.ui?.refresh).toEqual(["intel"]);
    expect(f.h.intel.projectIntel("p3").outcome?.desiredOutcome).toBe("Clients book online");
    expect(f.dir.dirs.get("p3")?.paidWhen).toBe("client signs off");
    const again = await f.call("set_finish_line", { confirmToken: o.confirmToken, userConfirmed: true });
    expect(again.ok).toBe(false);
  });

  it("refuses expired tokens, other sessions and handles cancel and click", async () => {
    const f = setup();
    const t1 = f.out(await f.call("set_priority", { project: "Beta", priority: 1 })).confirmToken;
    expect((await f.call("set_priority", { confirmToken: t1, userConfirmed: true }, "s2")).ok).toBe(false);
    f.advance(121_000);
    expect((await f.call("set_priority", { confirmToken: t1, userConfirmed: true })).ok).toBe(false);
    expect(f.dir.dirs.get("p3")).toBeUndefined();

    const t2 = f.out(await f.call("set_priority", { project: "Beta", priority: 2 })).confirmToken;
    const no = await f.call("set_priority", { confirmToken: t2, userConfirmed: false });
    expect(f.out(no).cancelled).toBe(true);
    expect(f.dir.dirs.get("p3")).toBeUndefined();

    const p3 = await f.call("set_priority", { project: "Beta", priority: 3 });
    const token = p3.confirm?.token ?? "";
    expect((await f.exec.click("s2", { token, accept: true })).ok).toBe(false);
    const click = await f.exec.click("s1", { token, accept: true });
    expect(click.ok).toBe(true);
    expect(f.dir.dirs.get("p3")?.priority).toBe(3);
    expect((await f.exec.click("s1", { token, accept: true })).ok).toBe(false);
  });

  it("journals by callId: a repeated call returns the stored result without re-running", async () => {
    const f = setup();
    const req = { callId: "same", name: "remember", args: { text: "Beta pays on launch", project: "Beta" } };
    const a = await f.exec.execute({ sessionId: "s1", projectId: null, autoApprove: false }, req);
    const b = await f.exec.execute({ sessionId: "s1", projectId: null, autoApprove: false }, req);
    expect(b).toEqual(a);
    expect(f.dir.notes).toHaveLength(1);
    expect(f.dir.notes[0]).toMatchObject({ projectId: "p3", source: "voice" });
  });

  it("uses the page's project by default and resolves items", async () => {
    const f = setup();
    f.h.intel.addItem("p1", { kind: "requirement", title: "Booking flow" });
    const r = await f.call("set_focus", { items: ["booking"] }, "s1", "p1");
    expect(f.out(r).needsConfirmation).toBe(true);
    await f.call("set_focus", { confirmToken: f.out(r).confirmToken, userConfirmed: true });
    expect(f.dir.dirs.get("p1")?.focusItemIds).toHaveLength(1);
  });

  it("prepare_ezcoder_tasks keeps the task text out of the model output", async () => {
    const f = setup();
    f.h.intel.putOutcome("p1", { desiredOutcome: "Acme books online", acceptanceCriteria: [] });
    f.h.intel.addFinishLineItems("p1", [{ title: "Booking flow" }]);
    const r = await f.call("prepare_ezcoder_tasks", { project: "Acme" });
    const ready = f.h.intel.projectIntel("p1").plan.ready;
    expect(ready.length).toBeGreaterThan(0);
    {
      expect(r.ui?.copy?.itemIds.length).toBe(ready.length);
      expect(r.ui?.copy?.text).toBeTruthy();
      expect(r.output).not.toContain(r.ui?.copy?.text ?? "@@");
      expect(f.out(r).copyCardShown).toBe(true);
    }
  });

  it("open_page builds validated links; end_session ends", async () => {
    const f = setup();
    expect((await f.call("open_page", { page: "focus", project: "Beta" })).ui?.navigate).toBe("#focus?project=p3");
    expect((await f.call("open_page", { page: "meetings", section: "asks" })).ui?.navigate).toBe("#meetings?section=asks");
    expect((await f.call("open_page", { page: "javascript:alert(1)" })).ok).toBe(false);
    expect((await f.call("end_session")).endSession).toBe(true);
    expect((await f.call("attach_document", { document: "contract", project: "Acme" })).ok).toBe(true);
    expect(f.documents.attached).toEqual(["p1"]);
  });

  it("meeting item action is confirmed before it runs", async () => {
    const f = setup();
    const p = await f.call("meeting_item_action", { item: "invoice draft", action: "done" });
    expect(f.statusCalls).toEqual([]);
    await f.exec.click("s1", { token: p.confirm?.token ?? "", accept: true });
    expect(f.statusCalls).toEqual(["done"]);
  });

  it("approve-all runs a write at once, journals it confirmed with the prefix and creates no token", async () => {
    const f = setup();
    const r = await f.call("set_priority", { project: "Beta", priority: 2 }, "s1", null, true);
    expect(r.confirm).toBeUndefined();
    expect(f.out(r)).toMatchObject({ done: true, autoApproved: true });
    expect(r.card?.tone).toBe("green");
    expect(r.card?.detail).toContain("Approved for this session");
    expect(f.dir.dirs.get("p3")?.priority).toBe(2);
    const row = f.db.prepare("SELECT status, summary FROM voice_actions WHERE name='set_priority'").get() as { status: string; summary: string };
    expect(row.status).toBe("confirmed");
    expect(row.summary.startsWith("Approved for this session: ")).toBe(true);
    // Off: still needs a token.
    const off = await f.call("set_priority", { project: "Beta", priority: 4 });
    expect(f.out(off).needsConfirmation).toBe(true);
    expect(f.dir.dirs.get("p3")?.priority).toBe(2);
  });

  it("find_noise counts and samples without quotes", async () => {
    const f = setup();
    f.tri.state.entries = [entry(1), entry(2, "old_asks")];
    const r = await f.call("find_noise");
    const o = f.out(r);
    expect(o.total).toBe(2);
    expect(o.hint).toBe("Offer to clear them in one go.");
    expect((o.samples as unknown[]).length).toBe(2);
    expect(r.output).not.toContain("SECRET VERBATIM QUOTE");
    expect(r.output).not.toContain("quote");
  });

  it("clean_up freezes its keys at prepare time and offers undo", async () => {
    const f = setup();
    f.tri.state.entries = Array.from({ length: 10 }, (_, i) => entry(i + 1));
    const p = await f.call("clean_up", { buckets: ["overdue_promises"] });
    expect(p.confirm?.title).toBe("Clear 10 items");
    expect(p.confirm?.details).toHaveLength(9);
    expect(p.confirm?.details.at(-1)).toBe("and 2 more");
    f.tri.state.entries = [...f.tri.state.entries.slice(0, 3), entry(99)];
    const yes = await f.call("clean_up", { confirmToken: p.confirm?.token, userConfirmed: true });
    expect(yes.ok).toBe(true);
    expect(f.tri.state.applied).toHaveLength(1);
    expect(f.tri.state.applied[0]?.keys).toEqual(Array.from({ length: 10 }, (_, i) => entry(i + 1).key));
    expect(f.tri.state.applied[0]?.source).toBe("voice");
    expect(yes.ui?.undo?.batchId).toMatch(/^tb-/);
    expect(yes.ui?.refresh).toEqual(["meetings", "intel", "portfolio"]);
    expect(f.batches).toEqual([yes.ui?.undo?.batchId]);
    f.tri.state.entries = [];
    expect((await f.call("clean_up", {})).ok).toBe(false);
  });

  it("clean_up runs at once with approve-all; undo_clean_up restores the session's latest batch", async () => {
    const f = setup();
    f.tri.state.entries = [entry(1), entry(2)];
    const r = await f.call("clean_up", {}, "s1", null, true);
    expect(f.out(r).autoApproved).toBe(true);
    const id = r.ui?.undo?.batchId;
    expect(id).toBeTruthy();
    const u = await f.call("undo_clean_up");
    expect(u.ok).toBe(true);
    expect(f.out(u).say).toContain("Restored 2 items");
    expect(f.tri.state.undone).toEqual([id]);
    expect((await f.call("undo_clean_up")).ok).toBe(false);
  });

  it("open_page can show Clean up", async () => {
    const f = setup();
    expect((await f.call("open_page", { page: "cleanup" })).ui?.navigate).toBe("#cleanup");
  });
});
