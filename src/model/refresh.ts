import { ezbossLinksDiscovery } from "../adapters/discovery-ezboss-links.ts";
import { ezcoderDiscovery } from "../adapters/discovery-ezcoder.ts";
import { pew2Discovery } from "../adapters/discovery-pew2.ts";
import { ezbossAgentState } from "../adapters/agent-ezboss.ts";
import { gitAdapter } from "../adapters/git.ts";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import { canonicalPath } from "../core/canonical-path.ts";
import { byRelevance, hasHumanRequest, selectActive } from "../core/relevance.ts";
import { buildPortfolio } from "./build.ts";
import { generateInbox, type InboxInput } from "./inbox.ts";
import { buildToday } from "../attention/today.ts";
import type { SourcePaths } from "../shared/paths.ts";
import type { Repo } from "../db/repo.ts";
import type { Portfolio } from "../shared/types.ts";

export function withAttention(portfolio: Portfolio, repo: Repo, now: Date): Portfolio {
  const inbox = repo.inbox(now).filter((i) => i.projectId);
  return { ...portfolio, inbox, today: buildToday(inbox, now), history: repo.inbox(now, true),
    remainingCount: Math.max(0, inbox.length - 3), newCount: inbox.filter((i) => !i.seenAt).length };
}

/** EZBoss plan tasks reference link names; build name → canonical path up front. */
async function linkNameMap(paths: SourcePaths): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const file = await readOnlyFs.readJson<{ projects?: unknown }>(paths.ezboss.links);
    for (const p of (file?.projects ?? []) as { name?: unknown; cwd?: unknown }[]) {
      if (typeof p?.name === "string" && typeof p?.cwd === "string") {
        map.set(p.name, canonicalPath(p.cwd));
      }
    }
  } catch {
    // The links adapter reports this failure; here it just means no mapping.
  }
  return map;
}

/**
 * One read of the external world into one snapshot, with no user input at any
 * point. External sources are read-only; the only writes are to our own store.
 */
export async function refresh(
  paths: SourcePaths,
  repo: Repo,
  now = new Date(),
): Promise<Portfolio> {
  const { data: projects, issues } = await buildPortfolio({
    discovery: [ezbossLinksDiscovery(paths), ezcoderDiscovery(paths), pew2Discovery(paths)],
    agent: ezbossAgentState(paths, await linkNameMap(paths)),
    git: gitAdapter(),
    repo,
    home: paths.home,
    now,
  });

  const visible = projects.filter((p) => !p.override.hidden);
  const active = selectActive(visible);
  const activeIds = new Set(active.map((p) => p.id));
  const other = visible.filter((p) => !activeIds.has(p.id)).sort(byRelevance);
  const hidden = projects.filter((p) => p.override.hidden).sort(byRelevance);

  // Inbox events come from the projects we actually looked at closely.
  const inboxInputs: InboxInput[] = [];
  for (const p of active) {
    inboxInputs.push({
      project: p,
      sessions: [],
      observed: p.tasksObserved,
    });
  }
  return repo.transaction(() => {
  generateInbox(inboxInputs, repo, now, repo.latest() === null);

  const portfolio: Portfolio = {
    generatedAt: now.toISOString(),
    coverage: {
      checked: visible.filter((p) => p.scanStatus === "checked").length,
      cached: visible.filter((p) => p.scanStatus === "cached").length,
      unavailable: visible.filter((p) => p.scanStatus === "unavailable").length,
      waitingOutsideCap: other.filter(hasHumanRequest).length,
    },
    active,
    other,
    hidden,
    today: [],
    inbox: [],
    issues,
  };
  const current = withAttention(portfolio, repo, now);
  repo.saveSnapshot(current);
  return current;
  });
}
