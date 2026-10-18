import { afterEach, describe, expect, it } from "vitest";
import { prioritizeProject, type PrioritizeProject } from "../src/intel/prioritize.ts";
import { IntelError } from "../src/intel/service.ts";
import type { DirectionApi } from "../src/intel/types.ts";
import { DIRECTION_NOTES_PER_PROJECT } from "../src/intel/types.ts";
import { intelHarness } from "./intel-fixture.ts";

const harnesses: ReturnType<typeof intelHarness>[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.close(); });
const make = () => { const h = intelHarness([{ id: "p1", name: "Acme" }, { id: "p2", name: "Beta" }]); harnesses.push(h); return h; };
const req = (h: ReturnType<typeof intelHarness>, projectId: string, title: string, dueDate?: string): string => {
  const intel = h.intel.addItem(projectId, { kind: "requirement", title, ...(dueDate ? { dueDate } : {}) });
  const item = intel.items.find((i) => i.title === title);
  if (!item) throw new Error("item missing");
  return item.id;
};
const changes = (h: ReturnType<typeof intelHarness>): string[] =>
  (h.db.prepare("SELECT summary FROM intel_changes WHERE kind='human_edit' ORDER BY seq").all() as { summary: string }[]).map((r) => r.summary);
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof IntelError ? e.code : "other"; } };

describe("direction drives the ranking", () => {
  it("implements DirectionApi", () => {
    const h = make();
    const api: DirectionApi = h.intel;
    expect(api.direction("p1")).toEqual({ projectId: "p1", paidWhen: null, priority: null, focusItemIds: [], notes: [], updatedAt: null });
    expect(code(() => api.direction("nope"))).toBe("not-found");
  });

  it("a priority boost reorders the Focus queue across projects", () => {
    const h = make();
    req(h, "p1", "Build invoices");
    req(h, "p2", "Build bookings");
    expect(h.intel.focus().queue.map((o) => o.projectId)).toEqual(["p1", "p2"]);
    const intel = h.intel.setDirection("p2", { priority: 1 });
    expect(intel.direction.priority).toBe(1);
    const f = h.intel.focus();
    expect(f.queue.map((o) => o.projectId)).toEqual(["p2", "p1"]);
    expect(f.top?.scoreReasons).toContainEqual({ code: "owner_priority", points: 45, detail: "You ranked this project #1 of your priorities" });
    expect(f.projects.find((r) => r.projectId === "p2")).toMatchObject({ priority: 1, paidWhen: null });
    h.intel.setDirection("p2", { priority: 5 });
    const five = h.intel.focus();
    expect(five.queue.map((o) => o.projectId)).toEqual(["p1", "p2"]);
    expect(five.queue[1]?.scoreReasons).toContainEqual({ code: "owner_priority", points: 0, detail: "You ranked this project #5" });
  });

  it("owner_focus moves a focus item's objective to the top within a project", () => {
    const h = make();
    const soon = req(h, "p1", "Build invoices", "2026-10-22");
    const later = req(h, "p1", "Build reports");
    expect(h.intel.projectIntel("p1").objective?.targetItemIds).toEqual([soon]);
    const intel = h.intel.setDirection("p1", { focusItemIds: [later, later] });
    expect(intel.direction.focusItemIds).toEqual([later]);
    expect(intel.objective?.targetItemIds).toEqual([later]);
    expect(intel.objective?.scoreReasons[0]).toEqual({ code: "owner_focus", points: 60, detail: "You told DAVE this matters most right now" });
    expect(changes(h).some((s) => s.startsWith("Direction: matters most now: Build reports"))).toBe(true);
    const recorded = h.db.prepare("SELECT summary FROM intel_changes WHERE kind='objective_changed' ORDER BY seq DESC LIMIT 1").get() as { summary: string };
    expect(recorded.summary).toContain("You told DAVE this matters most right now");
  });

  it("rejects bad direction and drops focus ids that stop existing", () => {
    const h = make();
    const mine = req(h, "p1", "Build invoices");
    const theirs = req(h, "p2", "Build bookings");
    expect(code(() => h.intel.setDirection("p1", { focusItemIds: [theirs] }))).toBe("invalid");
    expect(code(() => h.intel.setDirection("p1", { focusItemIds: ["0123456789abcdef"] }))).toBe("invalid");
    expect(code(() => h.intel.setDirection("p1", { priority: 0 }))).toBe("invalid");
    expect(code(() => h.intel.setDirection("p1", { priority: 2.5 }))).toBe("invalid");
    expect(code(() => h.intel.setDirection("p1", { paidWhen: "x".repeat(501) }))).toBe("invalid");
    expect(code(() => h.intel.setDirection("nope", { priority: 1 }))).toBe("not-found");
    expect(h.intel.setDirection("p1", { paidWhen: "  " }).direction.paidWhen).toBeNull();
    expect(h.intel.setDirection("p1", { paidWhen: " Client signs off ", focusItemIds: [mine] }).direction).toMatchObject({ paidWhen: "Client signs off", focusItemIds: [mine] });
    expect(h.intel.focus().projects.find((r) => r.projectId === "p1")?.paidWhen).toBe("Client signs off");
    h.db.prepare("DELETE FROM intel_items WHERE id=?").run(mine);
    expect(h.intel.direction("p1").focusItemIds).toEqual([]);
  });

  it("notes: CRUD, caps and portfolio-wide notes", () => {
    const h = make();
    expect(code(() => h.intel.addDirectionNote("p1", "   ", "ui"))).toBe("invalid");
    expect(code(() => h.intel.addDirectionNote("p1", "x".repeat(501), "ui"))).toBe("invalid");
    expect(code(() => h.intel.addDirectionNote("nope", "x", "ui"))).toBe("not-found");
    expect(h.intel.addDirectionNote("p1", "x".repeat(500), "voice").text).toHaveLength(500);
    h.setNow("2026-10-12T10:00:00.000Z");
    const n = h.intel.addDirectionNote("p1", "  Booking first  ", "ui");
    expect(n).toMatchObject({ projectId: "p1", text: "Booking first", source: "ui" });
    expect(n.id).toMatch(/^[a-f0-9]{16}$/);
    const wide = h.intel.addDirectionNote(null, "Cash flow matters this month", "voice");
    expect(h.intel.directionNotes(null, 10).map((x) => x.id)).toEqual([wide.id]);
    expect(h.intel.directionNotes("all", 10).map((x) => x.id)[0]).toBe(wide.id);
    expect(h.intel.direction("p1").notes.map((x) => x.text)[0]).toBe("Booking first");
    h.intel.deleteDirectionNote(n.id);
    expect(code(() => h.intel.deleteDirectionNote(n.id))).toBe("not-found");
    expect(h.intel.directionNotes("p1", 10)).toHaveLength(1);
    for (let i = 0; i < DIRECTION_NOTES_PER_PROJECT + 1; i += 1) {
      h.setNow(new Date(Date.parse("2026-10-13T00:00:00.000Z") + i * 1000).toISOString());
      h.intel.addDirectionNote("p2", `note ${i}`, "ui");
    }
    const kept = h.intel.directionNotes("p2", 1000);
    expect(kept).toHaveLength(DIRECTION_NOTES_PER_PROJECT);
    expect(kept[0]?.text).toBe(`note ${DIRECTION_NOTES_PER_PROJECT}`);
    expect(kept.some((x) => x.text === "note 0")).toBe(false);
    expect(h.intel.directionNotes("p1", 10)).toHaveLength(1);
  });

  it("every direction change logs a 'Direction: ' entry", () => {
    const h = make();
    h.intel.setDirection("p1", { priority: 1 });
    h.intel.setDirection("p1", { paidWhen: "Signed off" });
    h.intel.setDirection("p1", { paidWhen: "Signed off" });
    const note = h.intel.addDirectionNote("p1", "Ship booking", "ui");
    h.intel.deleteDirectionNote(note.id);
    expect(changes(h)).toEqual(["Direction: priority set to 1", "Direction: paid when Signed off", "Direction: noted Ship booking", "Direction: note removed: Ship booking"]);
  });

  it("no direction ranks exactly as before", () => {
    const h = make();
    req(h, "p1", "Build invoices", "2026-10-14");
    req(h, "p1", "Build reports");
    const base: PrioritizeProject = {
      projectId: "p1", projectName: "Acme", items: h.intel.store.items("p1"), stage: "building",
      readiness: { code_complete: "unknown", deployed: "unknown", usable_by_client: "unknown", client_accepted: "unknown" },
      hasOutcome: false, outcomeDraftPending: false, uncertain: null,
    };
    const now = new Date("2026-10-12T09:00:00.000Z");
    const plain = JSON.stringify(prioritizeProject(base, now));
    expect(JSON.stringify(prioritizeProject({ ...base, direction: undefined }, now))).toBe(plain);
    expect(JSON.stringify(prioritizeProject({ ...base, direction: { priority: null, focusItemIds: [] } }, now))).toBe(plain);
  });
});
