import { describe, expect, it } from "vitest";
import { summarize, summaryFingerprint } from "../src/model/summarize.ts";
import { emptyActivity } from "../src/shared/types.ts";
import type { TechnicalActivity } from "../src/shared/types.ts";
import type { SummaryInput } from "../src/model/summarize.ts";
import { AT, ago, task } from "./helpers.ts";

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    projectName: "alpha",
    activity: emptyActivity(),
    tasks: [],
    sessions: [],
    docs: [],
    observedAt: AT,
    ...over,
  };
}

const activity = (over: Partial<TechnicalActivity> = {}) => ({ ...emptyActivity(), ...over });

const session = (over: Partial<{ file: string; startedAt: string; request: string | null; failed: boolean }> = {}) => ({
  file: "/s/2026-09-01T10-00-00Z_a.jsonl",
  startedAt: ago(4),
  request: "wire the AI chat frontend to the query engine",
  failed: false,
  ...over,
});

describe("summarize", () => {
  it("answers all four questions from evidence, with no user input", () => {
    const s = summarize(
      input({
        sessions: [session()],
        tasks: [task({ status: "in_progress", title: "add query planner" }), task({ id: "t2", status: "done", title: "schema migration" })],
        activity: activity({ dirty: true, dirtyFileCount: 4, branch: "main" }),
      }),
    );
    expect(s.recentFocus).toBe("wire the AI chat frontend to the query engine");
    expect(s.completed).toContain("schema migration");
    expect(s.unfinished).toContain("add query planner");
    expect(s.unfinished).toContain("4 uncommitted file(s)");
    expect(s.suggestedNextAction).toBe('Resume "add query planner"');
  });

  it("prefers the session request over a commit subject for recent focus", () => {
    const s = summarize(
      input({
        sessions: [session()],
        activity: activity({ lastCommitSubject: "chore: bump deps" }),
      }),
    );
    expect(s.recentFocus).toBe("wire the AI chat frontend to the query engine");
  });

  it("falls back to the commit subject when no session request exists", () => {
    const s = summarize(input({ activity: activity({ lastCommitSubject: "fix invoice rounding" }) }));
    expect(s.recentFocus).toBe("fix invoice rounding");
    expect(s.evidence.some((e) => e.kind === "git")).toBe(true);
  });

  it("leaves questions unanswered rather than guessing", () => {
    const s = summarize(input());
    expect(s.recentFocus).toBeNull();
    expect(s.completed).toBeNull();
    expect(s.unfinished).toBeNull();
    expect(s.suggestedNextAction).toBeNull();
    expect(s.evidence).toEqual([]);
  });

  it("cites evidence for every answer it gives", () => {
    const s = summarize({
      ...input({ sessions: [session()], tasks: [task({ status: "blocked", title: "waiting on API key" })] }),
    });
    expect(s.evidence.length).toBeGreaterThanOrEqual(2);
    expect(s.evidence.some((e) => e.kind === "session" && e.path?.endsWith(".jsonl"))).toBe(true);
    expect(s.evidence.some((e) => e.detail.includes("waiting on API key"))).toBe(true);
  });

  it("prioritises unblocking over resuming in the suggested action", () => {
    const s = summarize(
      input({
        tasks: [task({ status: "in_progress", title: "build it" }), task({ id: "t2", status: "blocked", title: "need credentials" })],
      }),
    );
    expect(s.suggestedNextAction).toBe('Unblock "need credentials"');
  });

  it("suggests committing when a dirty tree is the only loose end", () => {
    const s = summarize(input({ activity: activity({ dirty: true, dirtyFileCount: 2 }) }));
    expect(s.suggestedNextAction).toBe("Review and commit the uncommitted work");
  });

  it("reports a failed run as unfinished work", () => {
    const s = summarize(input({ sessions: [session({ failed: true })] }));
    expect(s.unfinished).toContain("failed");
  });

  it("summarises commits as completed only when no tasks exist", () => {
    const withTasks = summarize(input({ tasks: [task({ status: "done", title: "ship it" })], activity: activity({ recentCommitSubjects: ["a", "b"] }) }));
    const commitsOnly = summarize(input({ activity: activity({ recentCommitSubjects: ["add export", "fix crash"] }) }));
    expect(withTasks.completed).toContain("ship it");
    expect(commitsOnly.completed).toContain("add export");
  });

  it("never marks a generated summary as edited", () => {
    expect(summarize(input({ sessions: [session()] })).edited).toBe(false);
  });
});

describe("summaryFingerprint", () => {
  it("is stable for identical evidence", () => {
    const a = input({ sessions: [session()], tasks: [task()] });
    expect(summaryFingerprint(a)).toBe(summaryFingerprint(input({ sessions: [session()], tasks: [task()] })));
  });

  it("changes when a task status changes", () => {
    const before = summaryFingerprint(input({ tasks: [task({ status: "pending" })] }));
    const after = summaryFingerprint(input({ tasks: [task({ status: "done" })] }));
    expect(before).not.toBe(after);
  });

  it("changes when a new commit lands", () => {
    const before = summaryFingerprint(input({ activity: activity({ lastCommitAt: ago(10) }) }));
    const after = summaryFingerprint(input({ activity: activity({ lastCommitAt: ago(1) }) }));
    expect(before).not.toBe(after);
  });

  it("ignores the observation time, so idle refreshes do not churn", () => {
    const a = summaryFingerprint(input({ observedAt: "2026-01-01T00:00:00.000Z" }));
    const b = summaryFingerprint(input({ observedAt: "2026-06-01T00:00:00.000Z" }));
    expect(a).toBe(b);
  });
});
