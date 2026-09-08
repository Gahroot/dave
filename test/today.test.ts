import { describe, expect, it } from "vitest";
import { buildToday, classifyTask, TODAY_LIMIT } from "../src/attention/today.ts";
import { generateInbox } from "../src/model/inbox.ts";
import { freshRepo, NOW, project, task } from "./helpers.ts";

describe("Today", () => {
  it("does not invent running, pending, done or bare-blocked obligations", () => {
    for (const status of ["in_progress", "pending", "done", "blocked", "skipped"] as const) {
      expect(classifyTask(task({ status, summary: null }))).toBeNull();
    }
    expect(buildToday([], NOW)).toEqual([]);
  });
  it("recognizes the real counsel sign-off request without promoting implementation work", () => {
    const request = task({ status: "in_progress", title: "P0 LEGAL-01 Counsel beta approval", summary: "Complete P0 LEGAL-01 from docs/PREMIUM-BETA-ROADMAP.md: Obtain counsel sign-off for brand, privacy, user chat, wipes, moderation, and exact mesos-only beta scope. Store approval evidence." });
    expect(classifyTask(request)?.kind).toBe("agent-question");
    expect(classifyTask({ ...request, status: "done" })).toBeNull();
    expect(classifyTask(task({ title: "Implement approval workflow", summary: "Add counsel sign-off controls to the UI." }))).toBeNull();
  });

  it("requires unresolved explicit requests or a useful blocker reason", () => {
    expect(classifyTask(task({ title: "needs your approval", status: "done" }))).toBeNull();
    expect(classifyTask(task({ title: "please review", status: "pending" }))?.kind).toBe("agent-question");
    expect(classifyTask(task({ status: "blocked", summary: "Database connection refused" }))?.kind).toBe("inspection");
    expect(classifyTask(task({ title: "approve design tokens" }))).toBeNull();
  });
  it("derives three recommendations from the same persisted queue and respects dismissal", () => {
    const { repo } = freshRepo();
    const id = repo.ensureProject("/p/alpha", "alpha", NOW.toISOString());
    const p = project({ id, tasks: [1,2,3,4].map((n) => task({ id: String(n), title: "needs your approval" })) });
    generateInbox([{ project: p, sessions: [] }], repo, NOW);
    expect(repo.inbox(NOW)).toHaveLength(4);
    expect(buildToday(repo.inbox(NOW), NOW)).toHaveLength(TODAY_LIMIT);
    for (const item of repo.inbox(NOW)) repo.attentionAction(item.id, "dismiss", NOW);
    generateInbox([{ project: p, sessions: [] }], repo, NOW);
    expect(buildToday(repo.inbox(NOW), NOW)).toEqual([]);
  });
});
