import { Button, Text } from "@mantine/core";
import { ArrowRight, CircleCheck, Hand } from "lucide-react";
import type { StatusSpec } from "../status.ts";
import type { TopAction } from "../top-action.ts";
import { StatusTile } from "./Status.tsx";

const YOUR_MOVE: StatusSpec = { tone: "amber", icon: Hand, label: "Your move" };
const CLEAR: StatusSpec = { tone: "green", icon: CircleCheck, label: "Nothing needs you" };

/** The one answer to "what should I do next?": the action, why it matters, and what finished looks like. */
export function NextBestAction({ action, href }: { action: TopAction | null; href: (action: TopAction) => string }) {
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
