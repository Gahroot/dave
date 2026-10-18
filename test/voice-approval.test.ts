import { describe, expect, it } from "vitest";
import { grantsApproval } from "../src/voice/approval.ts";

describe("grantsApproval", () => {
  it.each([
    "You have my approval.", "you have my permission", "You've got my go-ahead!", "I approve all of these", "I approve everything",
    "Don’t ask me, just do it", "No need to confirm", "do not ask", "Go ahead without asking", "Just do it.", "Yes to all",
    "auto-approve", "Auto approve everything", "Approve all", "you don't need to ask me",
    "Don't check with me", "Do it without checking with me",
  ])("grants: %s", (w) => expect(grantsApproval(w)).toBe(true));

  it.each([
    "not approved", "I don't approve", "Did the client approve the design?", "We're waiting for approval from Acme",
    "do I have to approve?", "Do you have my approval?", "the client approved it", "ask me again", "I never give approval",
    "approve all?", "no permission for that", "set the goal to booking", "approval", "Don’t approve anything",
    "Don't check with the client first", "send it without checking the dates",
  ])("refuses: %s", (w) => expect(grantsApproval(w)).toBe(false));

  it("refuses missing or empty words", () => {
    expect(grantsApproval(undefined)).toBe(false);
    expect(grantsApproval("")).toBe(false);
    expect(grantsApproval("   ")).toBe(false);
    expect(grantsApproval(`${"x ".repeat(1500)}just do it`)).toBe(false);
  });
});
