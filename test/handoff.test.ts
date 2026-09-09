import { expect, it } from "vitest";
import { handoff, projectWorkBrief } from "../src/ui/format.ts";
import { freshRepo, NOW, project, task } from "./helpers.ts";
import { generateInbox } from "../src/model/inbox.ts";

it("bounds and sanitizes project-only briefs without granting execution", () => {
  const p = project();
  p.name = 'Synthetic ' + 'x'.repeat(5000);
  p.summary = { ...p.summary, recentFocus: '```sh\nnpm run deploy\n```', unfinished: 'https://example.test/private', suggestedNextAction: 'Prepare case ' + 'y'.repeat(5000), nextActionEditedAt: NOW.toISOString(), edited: true };
  const text = projectWorkBrief(p);
  expect(text).toContain('context only; no execution authorized');
  expect(text).toContain('Chosen next action: Prepare case');
  expect(text).toContain(`Action saved: ${NOW.toISOString()}`);
  expect(text).not.toContain('npm run deploy');
  expect(text).not.toContain('https://');
  expect(text.length).toBeLessThanOrEqual(3500);
});

it("creates bounded plain context with directory and source dates, excluding code and credentials", () => {
  const { repo } = freshRepo();
  const id = repo.ensureProject("/synthetic/project", "Synthetic", NOW.toISOString());
  const p = project({ id, canonicalPath: "/synthetic/project", tasks: [task({ title: "needs your input", summary: "token=synthetic-secret\n$ rm fixture\n```sh\nnpm run deploy\n```\n" + "x".repeat(5000) })] });
  generateInbox([{ project: p, sessions: [] }], repo, NOW);
  const text = handoff(p, repo.inbox(NOW)[0]!);
  expect(text).toContain("Directory: /synthetic/project");
  expect(text).toContain("Source: ezboss-task");
  expect(text).toContain(NOW.toISOString());
  expect(text).not.toContain("synthetic-secret");
  expect(text).not.toContain("npm run deploy");
  expect(text.length).toBeLessThanOrEqual(3500);
});
