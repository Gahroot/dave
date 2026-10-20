import type { ItemKind } from "./types.ts";

/**
 * Selective meetings: is a meeting statement a firm promise (or request, or agreed decision) or only a tentative
 * idea? Pure and deterministic, no Node imports, so the UI can use it too.
 *
 * Only firm items feed reconcile, the Inbox, follow-up checks, roadmap promises and plan commitments. Tentative items
 * are kept as "ideas mentioned" and can be promoted with one click. A strength the owner set (`strength_source`
 * 'user') always wins over both the model and these rules.
 */
export type Strength = "firm" | "tentative";
export const STRENGTHS: readonly Strength[] = ["firm", "tentative"];
export type StrengthSource = "model" | "rule" | "user";
export const STRENGTH_SOURCES: readonly StrengthSource[] = ["model", "rule", "user"];

export type ObligationReason =
  | "pain_point"
  | "hedge"
  | "pledge"
  | "pledge_deadline"
  | "no_pledge"
  | "ask"
  | "no_ask"
  | "agreement"
  | "no_agreement";

export type Obligation = { strength: Strength; reason: ObligationReason };

const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
/** "by Friday", "by tomorrow", "by end of week", "by next week", "by 3 Oct", "by Oct 3rd", "by 2026-10-20". */
const DEADLINE = new RegExp(
  `\\bby\\s+(?:(?:this|next)\\s+)?(?:${WEEKDAY}|tomorrow|tonight|(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:day|week|month)|eod|eow|next\\s+week|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|the\\s+\\d{1,2}(?:st|nd|rd|th))\\b`,
  "i",
);

/** Words that turn a statement into a maybe. `could` is the weak one (see WEAK_HEDGE). */
const HEDGE = /\b(?:maybe|might|possibly|perhaps|we should|should probably|would be (?:nice|cool|great|good)|it'd be|what if|think(?:ing)? about|consider(?:ing)?(?!\s+it\s+done)|someday|eventually|at some point|down the road|in the future|not sure|i guess|ideally|i wish|if we have time|just an idea|brainstorm\w*|thinking out loud|kind of|sort of|play with|explor\w*)\b/i;
/** "I could have it by Friday" is a pledge with a date: `could` alone is beaten by a deadline. */
const WEAK_HEDGE = /\bcould\b/i;

const PLEDGE = /\b(?:i'll|i will|we'll|we will|i'm going to|i am going to|we're going to|we are going to|i can have|we can have|you'll have|i'll get you|i'll send|i'll share|will do|on it|i promise|consider it done|count on me|happy to|no problem|absolutely|definitely|sure thing|i can (?:send|share|get|do|have|deliver|finish|fix|set up))\b/i;

/** A request: "we need", "can you", "could you (please)", "please", "must", "has to", "required", "need you to". */
const ASK = /\b(?:we need|we really need|can you|could you(?: please)?|please|must|has to|have to|needs to|required|need you to)\b/gi;

/** An agreed decision: "let's go with", "agreed", "we'll go with", "decided", "final answer", "sounds good, let's". */
const AGREEMENT = /\b(?:let's go with|let us go with|agreed|we'll go with|we will go with|we're going with|we are going with|decided|final answer|sounds good,? let's)\b/i;

/** Curly apostrophes and quotes read the same as straight ones. */
const normalise = (s: string): string => s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim();

export type ObligationInput = { kind: ItemKind; text: string; quote: string };

/** Rule-based reading of one meeting item. Reads the verbatim quote and DAVE's own wording together. */
export function classifyObligation(input: ObligationInput): Obligation {
  if (input.kind === "pain_point") return { strength: "firm", reason: "pain_point" };
  const all = normalise(`${input.quote} ${input.text}`);
  if (input.kind === "suggestion") {
    // "could you please" is a request, not a hedge: drop the request words before looking for a hedge.
    const asked = all.match(ASK) !== null;
    const rest = all.replace(ASK, " ");
    if (HEDGE.test(rest) || (!asked && WEAK_HEDGE.test(rest))) return { strength: "tentative", reason: "hedge" };
    return asked ? { strength: "firm", reason: "ask" } : { strength: "tentative", reason: "no_ask" };
  }
  if (HEDGE.test(all)) return { strength: "tentative", reason: "hedge" };
  if (input.kind === "decision") {
    if (WEAK_HEDGE.test(all)) return { strength: "tentative", reason: "hedge" };
    return AGREEMENT.test(all) ? { strength: "firm", reason: "agreement" } : { strength: "tentative", reason: "no_agreement" };
  }
  // Commitment: a pledge (or a promised date) with no hedge. A date beats the weak hedge "could".
  const deadline = DEADLINE.test(all);
  const pledge = PLEDGE.test(all) || deadline;
  if (WEAK_HEDGE.test(all) && !deadline) return { strength: "tentative", reason: "hedge" };
  if (!pledge) return { strength: "tentative", reason: "no_pledge" };
  return { strength: "firm", reason: deadline ? "pledge_deadline" : "pledge" };
}

/**
 * The model's reading combined with the rule. The model saying tentative, or the rule finding a hedge, makes it
 * tentative. When the model gave nothing (an answer from before meetings-v2), the rule decides alone. When the model
 * said firm and the rule only found no marker (no pledge, ask or agreement words), the model's firm stands: a missing
 * marker is not a hedge.
 */
export function combineStrength(model: Strength | null, rule: Obligation): Strength {
  if (model === null) return rule.strength;
  if (model === "tentative") return "tentative";
  return rule.reason === "hedge" ? "tentative" : "firm";
}

/** The strength every consumer reads: the stored one, else the rule (rows analysed before v16 store none). */
export function effectiveStrength(item: { strength: Strength | null | undefined; kind: ItemKind; text: string; quote: string }): Strength {
  if (item.strength === "firm" || item.strength === "tentative") return item.strength;
  return classifyObligation(item).strength;
}

export const isTentative = (item: { strength: Strength | null | undefined; kind: ItemKind; text: string; quote: string }): boolean =>
  effectiveStrength(item) === "tentative";
