import { describe, expect, it } from "vitest";
import { generateInbox } from "../src/model/inbox.ts";
import { buildToday } from "../src/attention/today.ts";
import { freshRepo, NOW, project, task } from "./helpers.ts";

describe("single attention queue", () => {
  it("deduplicates observations and never ignores a dismissal in Today", () => {
    const { repo } = freshRepo();
    const id = repo.ensureProject("/p/alpha", "alpha", NOW.toISOString());
    const p = project({ id, tasks: [task({ status: "blocked", title: "needs your approval to deploy" })] });
    const args = [{ project: p, sessions: [] }];
    generateInbox(args, repo, NOW);
    generateInbox(args, repo, NOW);
    expect(repo.inbox(NOW)).toHaveLength(1);
    expect(buildToday(repo.inbox(NOW), NOW)).toHaveLength(1);
    repo.attentionAction(repo.inbox(NOW)[0]!.id, "dismiss", NOW);
    generateInbox(args, repo, NOW);
    expect(repo.inbox(NOW)).toEqual([]);
    expect(buildToday(repo.inbox(NOW), NOW)).toEqual([]);
  });

  it("does not promote session-prefix failure, completed work, dirty files or concurrent records", () => {
    const { repo } = freshRepo();
    const id = repo.ensureProject("/p/alpha", "alpha", NOW.toISOString());
    const p = project({ id, tasks: [
      task({ id: "a", status: "in_progress" }), task({ id: "b", status: "in_progress" }),
      ...[1,2,3].map((n) => task({ id: String(n), status: "done", title: "needs your approval" })),
    ] });
    p.activity.dirty = true;
    generateInbox([{ project: p, sessions: [{ file: "/s/a.jsonl", startedAt: NOW.toISOString(), request: "export", failed: true }] }], repo, NOW);
    expect(repo.inbox(NOW)).toEqual([]);
  });

  it("preserves missing evidence on failed reads, clears on successful reads, skips hidden projects", () => {
    const { repo } = freshRepo();
    const id = repo.ensureProject("/p/alpha", "alpha", NOW.toISOString());
    const p = project({ id, tasks: [task({ title: "please confirm" })] });
    generateInbox([{ project: p, sessions: [] }], repo, NOW);
    generateInbox([{ project: { ...p, tasks: [] }, sessions: [], observed: false }], repo, NOW);
    expect(repo.inbox(NOW)).toHaveLength(1);
    generateInbox([{ project: { ...p, tasks: [] }, sessions: [] }], repo, NOW);
    expect(repo.inbox(NOW)).toEqual([]);
    generateInbox([{ project: { ...p, override: { pinned: false, hidden: true } }, sessions: [] }], repo, NOW);
    expect(repo.inbox(NOW)).toEqual([]);
    expect(repo.inbox(NOW, true)).toHaveLength(1);
  });
});
