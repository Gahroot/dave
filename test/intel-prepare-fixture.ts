import type { ActiveSkip, ActedInput, LedgerApi, SkipInput } from "../src/intel/ledger-types.ts";
import type { NextMeetings } from "../src/intel/next.ts";
import type { MeetingItem } from "../src/meetings/types.ts";
import type { ProgressReport } from "../src/work/types.ts";

/** Shared fakes for the prepared-action, briefing and next-route tests. */
export const NOW = "2026-10-12T09:00:00.000Z";

export function report(over: Partial<ProgressReport> & Pick<ProgressReport, "eventId" | "at">): ProgressReport {
  return {
    projectId: "p1", projectName: "Acme", headline: "EZ Coder finished: work looks implemented (not verified).", verdict: "moved", advanced: [], stillMissing: [],
    finishLine: { verified: 0, observed: 1, total: 2, percentDone: 0 }, nextBefore: null, nextAfter: null, source: "ezcoder", link: "explicit", observedAt: over.at, ...over,
  };
}

export function fakeLedger() {
  const skips = new Map<string, ActiveSkip>();
  const acted: ActedInput[] = [];
  let clock = () => new Date(NOW);
  const ledger: LedgerApi = {
    skip: (s: SkipInput) => { skips.set(s.actionId, { ...s, createdAt: clock().toISOString() }); },
    activeSkips: () => [...skips.values()].filter((s) => !s.until || Date.parse(s.until) > clock().getTime()),
    markActed: (a) => { acted.push(a); },
    review: () => { throw new Error("not used"); },
  };
  return { ledger, skips, acted, setClock: (f: () => Date) => { clock = f; } };
}

export function fakeMeetings(items: MeetingItem[] = []): NextMeetings & { done: string[] } {
  const done: string[] = [];
  return { done, items: () => items, setItemStatus: (id, action) => { done.push(`${id}:${String(action)}`); const i = items.find((x) => x.id === id); if (!i) throw new Error("unknown"); return i; } };
}

