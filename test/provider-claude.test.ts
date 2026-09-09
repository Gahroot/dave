import { expect, it } from "vitest";
import { claudeStatus, requireClaudePlanning, CLAUDE_ISOLATION_BLOCKER } from "../src/providers/claude.ts";

it("keeps subscription planning unavailable rather than falling back to API billing", () => {
  expect(claudeStatus()).toEqual({ provider: "claude", state: "unavailable",
    models: ["claude-fable-5-1", "claude-opus-5"], error: CLAUDE_ISOLATION_BLOCKER });
  expect(() => requireClaudePlanning()).toThrow(CLAUDE_ISOLATION_BLOCKER);
});
