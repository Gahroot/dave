import type { IntelItem, Lane } from "./types.ts";
import { normaliseKey, significantTokens } from "./store.ts";

/**
 * Shared, pure scope rules used by both the objective prioritiser and the delivery plan. Kept in one place so the two
 * never disagree about what is open, what is a bell or whistle, or which client blocker holds which piece of work.
 */
export const isOpen = (i: IntelItem): boolean => i.status === "open" || i.status === "in_progress";
/** UTC day number of an ISO date or timestamp; whole days only, so the clock time never changes a ranking. */
export const dayNumber = (iso: string): number => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/** Wording that marks an item as off the finish line (polish, wishlist or a later phase). */
export const POLISH = /\b(polish|nice[- ]to[- ]have|animat\w*|dark mode|theme|colou?rs?|fonts?|prett(y|ier)|fancy|bonus|extra|wishlist|someday|later|future|phase ?2|v2|would be nice|maybe)\b/i;

/** A stored lane is the person's decision and always wins; otherwise DAVE guesses from the wording and says so. */
export function laneOf(item: IntelItem): { lane: Lane; guessed: boolean } {
  if (item.lane) return { lane: item.lane, guessed: false };
  return { lane: POLISH.test(`${item.title} ${item.detail ?? ""}`) ? "extra" : "finish_line", guessed: true };
}

const GENERIC = new Set(["credential", "access", "api", "key", "client", "send", "provide", "account", "login", "password", "token", "secret", "permission", "sandbox", "share", "give", "get", "wait", "waiting", "require", "depend", "invite"]);

export type BlockerIndex = {
  /** Open blockers owned by the client or a third party, in input order. */
  openBlockers: IntelItem[];
  /** Blocker id → open work it holds up (explicit dependency or a shared specific word). */
  blockedBy: Map<string, IntelItem[]>;
  /** Work item id → the open blockers holding it up. */
  blockerOf: Map<string, IntelItem[]>;
};

export function blockerIndex(items: IntelItem[]): BlockerIndex {
  const openBlockers = items.filter((i) => i.kind === "blocker" && isOpen(i) && (i.owner === "client" || i.owner === "third_party"));
  const heldUp = (b: IntelItem): IntelItem[] => {
    const bt = new Set(significantTokens(b.title).filter((t) => !GENERIC.has(t)));
    return items.filter((i) => (i.kind === "requirement" || i.kind === "milestone" || (i.kind === "commitment" && i.owner !== "client")) && isOpen(i) &&
      (i.dependsOn.includes(b.id) || significantTokens(`${i.title} ${i.detail ?? ""}`).some((t) => bt.has(t))));
  };
  const blockedBy = new Map<string, IntelItem[]>();
  const blockerOf = new Map<string, IntelItem[]>();
  for (const b of openBlockers) {
    const held = heldUp(b);
    blockedBy.set(b.id, held);
    for (const i of held) blockerOf.set(i.id, [...(blockerOf.get(i.id) ?? []), b]);
  }
  return { openBlockers, blockedBy, blockerOf };
}

/**
 * True when `text` carries enough of the title's significant words: all of a one-word title, otherwise at least 60%
 * (and never fewer than two). Deliberately stricter than "any word matches" to avoid false "already built" claims.
 */
export function titleMatches(title: string, text: string): boolean {
  const tokens = significantTokens(title);
  if (!tokens.length) return false;
  const need = tokens.length === 1 ? 1 : Math.max(2, Math.ceil(tokens.length * 0.6));
  const set = new Set(normaliseKey(text).split(" "));
  return tokens.filter((t) => set.has(t)).length >= need;
}
