import { describe, expect, it } from "vitest";
import { classifyObligation, combineStrength, effectiveStrength } from "../src/meetings/obligation.ts";
import type { ItemKind } from "../src/meetings/types.ts";

const read = (kind: ItemKind, quote: string, text = "") => classifyObligation({ kind, quote, text });

describe("classifyObligation", () => {
  it.each([
    ["I'll send you the revised quote by Friday", "firm", "pledge_deadline"],
    ["I will get the staging link over to you", "firm", "pledge"],
    ["I could have it by Friday", "firm", "pledge_deadline"],
    ["I could take a look at that", "tentative", "hedge"],
    ["we could maybe add export", "tentative", "hedge"],
    ["Maybe I'll add dark mode at some point", "tentative", "hedge"],
    ["I'll think about a reporting page", "tentative", "hedge"],
    ["It would be nice to have SSO eventually", "tentative", "hedge"],
    ["We should probably redo onboarding", "tentative", "hedge"],
    ["Consider it done", "firm", "pledge"],
    ["We're considering a mobile app", "tentative", "hedge"],
    ["Yeah, that is interesting", "tentative", "no_pledge"],
    ["I’ll send the contract tomorrow, consider it done", "firm", "pledge"],
    ["Okay, done by end of week", "firm", "pledge_deadline"],
  ] as const)("commitment %j → %s", (quote, strength, reason) => {
    expect(read("commitment", quote)).toEqual({ strength, reason });
  });

  it("reads DAVE's own wording too: a promised date in the item text is a pledge", () => {
    expect(read("commitment", "Friday works.", "Send the revised quote by Friday")).toEqual({ strength: "firm", reason: "pledge_deadline" });
  });

  it.each([
    ["Can you add a CSV export?", "firm", "ask"],
    ["Could you please send the invoice copy", "firm", "ask"],
    ["We need the booking flow to handle refunds", "firm", "ask"],
    ["It has to work on mobile", "firm", "ask"],
    ["It would be cool to have dark mode", "tentative", "hedge"],
    ["we could maybe add export", "tentative", "hedge"],
    ["A dashboard would help", "tentative", "no_ask"],
    ["Can you maybe think about SSO someday", "tentative", "hedge"],
  ] as const)("suggestion %j → %s", (quote, strength, reason) => {
    expect(read("suggestion", quote)).toEqual({ strength, reason });
  });

  it.each([
    ["Let's go with Stripe", "firm", "agreement"],
    ["Agreed, weekly invoices", "firm", "agreement"],
    ["Sounds good, let's ship Tuesdays", "firm", "agreement"],
    ["Maybe we go with Stripe", "tentative", "hedge"],
    ["We could go with Stripe", "tentative", "hedge"],
    ["Stripe or Paddle, not sure yet", "tentative", "hedge"],
    ["Stripe is an option", "tentative", "no_agreement"],
  ] as const)("decision %j → %s", (quote, strength, reason) => {
    expect(read("decision", quote)).toEqual({ strength, reason });
  });

  it("pain points are always firm", () => {
    expect(read("pain_point", "Maybe it's the export that keeps crashing")).toEqual({ strength: "firm", reason: "pain_point" });
  });
});

describe("combineStrength", () => {
  const pledge = { strength: "firm", reason: "pledge" } as const;
  const hedge = { strength: "tentative", reason: "hedge" } as const;
  const noPledge = { strength: "tentative", reason: "no_pledge" } as const;
  it("is tentative when either the model or a hedge says so", () => {
    expect(combineStrength("tentative", pledge)).toBe("tentative");
    expect(combineStrength("firm", hedge)).toBe("tentative");
  });
  it("lets the rule decide when the model gave nothing", () => {
    expect(combineStrength(null, pledge)).toBe("firm");
    expect(combineStrength(null, noPledge)).toBe("tentative");
  });
  it("keeps the model's firm when the rule only found no marker", () => {
    expect(combineStrength("firm", noPledge)).toBe("firm");
    expect(combineStrength("firm", pledge)).toBe("firm");
  });
});

describe("effectiveStrength", () => {
  it("returns the stored strength, else classifies a legacy row on read", () => {
    expect(effectiveStrength({ strength: "firm", kind: "commitment", quote: "maybe", text: "maybe" })).toBe("firm");
    expect(effectiveStrength({ strength: null, kind: "commitment", quote: "we could maybe add export", text: "Add export" })).toBe("tentative");
    expect(effectiveStrength({ strength: undefined, kind: "commitment", quote: "I'll send it Monday", text: "Send the deck" })).toBe("firm");
  });
});
