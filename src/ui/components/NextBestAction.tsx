import { useCallback, useEffect, useState } from "react";
import { Button, Text } from "@mantine/core";
import { ArrowRight, CircleCheck, Hand } from "lucide-react";
import type { StatusSpec } from "../status.ts";
import type { TopAction } from "../top-action.ts";
import { StatusTile } from "./Status.tsx";
import type { NextState } from "../../intel/next-types.ts";
import { nextApi, type NextActInput } from "../next-api.ts";
import { PreparedActionCard } from "../sections/focus/PreparedAction.tsx";

const YOUR_MOVE: StatusSpec = { tone: "amber", icon: Hand, label: "Your move" };
const CLEAR: StatusSpec = { tone: "green", icon: CircleCheck, label: "Nothing needs you" };

export type PreparedNext = { state: NextState | null; busy: boolean; error: string | null; act: (input: NextActInput) => void };

/**
 * DAVE's prepared next action (GET /api/intel/next) and its record-only act. Paused = no fetch.
 * `onActed` runs after a successful act, so a host view can reload what the act changed (decisions, steps).
 */
export function usePreparedNext(paused = false, onActed?: () => void): PreparedNext {
  const [state, setState] = useState<NextState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (paused) return;
    const ctl = new AbortController();
    nextApi.next(ctl.signal).then(setState).catch(() => { if (!ctl.signal.aborted) setState(null); });
    return () => ctl.abort();
  }, [paused]);
  const act = useCallback((input: NextActInput) => {
    const id = state?.action?.id;
    if (!id) return;
    setBusy(true); setError(null);
    nextApi.act(id, input).then((r) => { setState(r.next); onActed?.(); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Request failed")).finally(() => setBusy(false));
  }, [state, onActed]);
  return { state, busy, error, act };
}

/** The prepared action as a hero panel, or nothing when DAVE has none ready. */
export function PreparedNextPanel({ next }: { next: PreparedNext }) {
  const { state, busy, error, act } = next;
  const prepared = state?.action ?? null;
  if (!prepared) return null;
  return <section className="app-panel next-best-action" aria-label="Next best action" data-testid="next-best-action">
    <div className="nba-top">
      <StatusTile spec={YOUR_MOVE} />
      <div className="nba-text">
        <p className="nba-kicker">Do this next</p>
        <PreparedActionCard action={prepared} onAct={act} busy={busy} error={error} />
        {state && state.queue.length > 1 && <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>Then: {state.queue.slice(1, 4).map((a) => `${a.projectName} – ${a.title}`).join(" · ")}</Text>}
      </div>
    </div>
  </section>;
}

/** The one answer to "what should I do next?": the action, why it matters, and what finished looks like. */
export function NextBestAction({ action, href }: { action: TopAction | null; href: (action: TopAction) => string }) {
  const next = usePreparedNext();
  if (next.state?.action) return <PreparedNextPanel next={next} />;
  if (!action) return <section className="app-panel next-best-action is-clear" aria-label="Next best action">
    <div className="nba-top"><StatusTile spec={CLEAR} /><div className="nba-text"><p className="nba-title">Nothing needs you right now</p><Text size="sm" c="dimmed">Everything loaded is waiting on someone else or already handled.</Text></div></div>
  </section>;
  const reason = action.row && action.row.reason && action.row.reason !== action.title ? ` ${action.row.reason}` : "";
  return <section className="app-panel next-best-action" aria-label="Next best action" data-testid="next-best-action">
    <div className="nba-top">
      <StatusTile spec={YOUR_MOVE} />
      <div className="nba-text">
        <p className="nba-kicker">Do this next · {action.project}</p>
        <p className="nba-title">{action.title}</p>
        <Text size="sm"><strong>Why it matters:</strong> {action.impact}{reason}</Text>
        <Text size="sm"><strong>Finished when:</strong> {action.done}</Text>
      </div>
    </div>
    <div className="nba-foot">
      <Button component="a" href={href(action)} rightSection={<ArrowRight size={16} aria-hidden="true" />}>Open it</Button>
      {!!action.alsoNext.length && <Text size="xs" c="dimmed">Then: {action.alsoNext.join(" · ")}</Text>}
    </div>
  </section>;
}
