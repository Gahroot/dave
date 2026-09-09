import { expect, it } from "vitest";
import { selectProjectNextAction } from "../src/ui/components/ProjectNextAction.tsx";
import { project, NOW } from "./helpers.ts";

it("selects explicit pinned choices in existing order, including cached projects without inbox items", () => {
  const chosen = project();
  chosen.override = { pinned: true, hidden: false };
  chosen.summary = { ...chosen.summary, edited: true, suggestedNextAction: "Prepare case", nextActionEditedAt: NOW.toISOString() };
  chosen.scanStatus = "cached";
  const excluded = [
    { ...chosen, override: { pinned: false, hidden: false } },
    { ...chosen, override: { pinned: true, hidden: true } },
    ...[
      { edited: false }, { nextActionEditedAt: undefined }, { nextActionEditedAt: null },
      { nextActionEditedAt: "invalid" }, { suggestedNextAction: "  " }, { suggestedNextAction: null },
    ].map((summary) => ({ ...chosen, summary: { ...chosen.summary, ...summary } })),
  ];
  expect(selectProjectNextAction({ active: excluded, other: [] })).toBeUndefined();
  expect(selectProjectNextAction({ active: excluded, other: [chosen] })).toBe(chosen);
  const second = { ...chosen, id: "second" };
  expect(selectProjectNextAction({ active: [chosen], other: [second] })).toBe(chosen);
});
