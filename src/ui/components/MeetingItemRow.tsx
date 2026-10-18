import { Button, Group, Stack, Text } from "@mantine/core";
import { Bot, Check, CircleSlash, ExternalLink, Handshake, Lightbulb, RotateCcw, Undo2 } from "lucide-react";
import type { MeetingItem } from "../../meetings/types.ts";
import { IDEA_KIND_LABELS, ITEM_KIND_LABELS, ITEM_STATUS_LABELS, promiseGroup, shortDay, timestamp } from "../meetings-model.ts";
import { routeLink } from "../navigation.ts";
import { StatusIcon, StatusMark } from "./Status.tsx";
import { ITEM_KIND, ITEM_STATUS, PROMISE_GROUP, hasRail, type StatusSpec } from "../status.ts";

export type ItemAction = "done" | "dropped" | "open" | "confirm" | "not_yet";
export type ItemStrength = "firm" | "tentative";

/** The state that most needs the owner: overdue/due soon beats the stored status, which beats the kind. */
function leadSpec(item: MeetingItem, now: Date): StatusSpec {
  if (item.status === "open" && item.kind === "commitment") {
    const group = promiseGroup(item, now);
    if (group === "overdue" || group === "due_soon") return PROMISE_GROUP[group];
  }
  return item.status === "open" ? ITEM_KIND[item.kind] : ITEM_STATUS[item.status];
}

/**
 * One promise, client ask or decision: the words that were said, where, and the
 * owner's options. DAVE never closes anything here without a click.
 */
export function MeetingItemRow({ item, busy, onAction, onStrength, returnTo, showProject = true, showMeeting = true, showKind = true, flag = "" }: {
  item: MeetingItem; busy: boolean; onAction: (item: MeetingItem, action: ItemAction) => void;
  /** When set, offers "It's a promise" on an idea and "Just an idea" on a promise. */
  onStrength?: (item: MeetingItem, strength: ItemStrength) => void;
  returnTo: string; showProject?: boolean; showMeeting?: boolean;
  /** Off where a heading already names the kind. */
  showKind?: boolean;
  /** A short state such as "Overdue", shown before the kind. */
  flag?: string;
}) {
  const textId = `meeting-item-${item.id}`;
  const act = (action: ItemAction, label: string, variant: "default" | "filled" | "subtle" = "default", icon?: React.ReactNode) =>
    <Button key={action} variant={variant} color={variant === "subtle" ? "dark" : undefined} leftSection={icon} disabled={busy} aria-describedby={textId} onClick={() => onAction(item, action)}>{label}</Button>;
  const actions = [];
  const idea = item.strength === "tentative";
  const closed = item.status === "done" || item.status === "dropped";
  if (item.kind !== "decision") {
    if (item.status === "looks_done") actions.push(act("confirm", item.suggestedStatus === "dropped" ? "Yes, it was dropped" : "Yes, it's done", "filled", <Check size={16} aria-hidden="true" />), act("not_yet", "Not yet", "default", <Undo2 size={16} aria-hidden="true" />));
    else if (closed) actions.push(act("open", "Reopen", "default", <RotateCcw size={16} aria-hidden="true" />));
    else if (item.status === "open" && idea) actions.push(act("dropped", "Dismiss", "subtle", <CircleSlash size={16} aria-hidden="true" />));
    else if (item.status === "open") {
      if (item.kind === "pain_point" && item.feature && item.projectId) {
        actions.push(<Button key="draft" component="a" leftSection={<Bot size={16} aria-hidden="true" />} aria-describedby={textId}
          href={routeLink("agents", { view: "new", project: item.projectId, meetingItem: item.id, return: returnTo })}>Draft agent assignment</Button>);
      }
      const primary = !(item.kind === "pain_point" && item.feature && item.projectId);
      actions.push(act("done", item.kind === "commitment" ? "Mark done" : "Mark handled", primary ? "filled" : "default", <Check size={16} aria-hidden="true" />), act("dropped", item.kind === "commitment" ? "Drop" : "Dismiss", "subtle", <CircleSlash size={16} aria-hidden="true" />));
    }
  }
  if (onStrength && (item.status === "open" || closed)) {
    actions.push(idea
      ? <Button key="firm" variant="default" leftSection={<Handshake size={16} aria-hidden="true" />} disabled={busy} aria-describedby={textId} onClick={() => onStrength(item, "firm")}>It's a promise</Button>
      : <Button key="tentative" variant="subtle" color="dark" leftSection={<Lightbulb size={16} aria-hidden="true" />} disabled={busy} aria-describedby={textId} onClick={() => onStrength(item, "tentative")}>Just an idea</Button>);
  }
  // An open idea shows as an idea (violet lightbulb), never with the promise icon, rail or due-soon alarm.
  const spec = idea && item.status === "open" ? ITEM_KIND.suggestion : leadSpec(item, new Date());
  const kindLabel = showKind ? (idea ? IDEA_KIND_LABELS : ITEM_KIND_LABELS)[item.kind] : "";
  const statusLabel = item.status !== "open" ? ITEM_STATUS_LABELS[item.status] : "";
  const due = item.dueDate ? `Due ${shortDay(item.dueDate)}${item.duePhrase ? ` (“${item.duePhrase}”)` : ""}` : item.duePhrase ? `“${item.duePhrase}”` : "";
  return <li className="meeting-item" data-tone={hasRail(spec.tone) ? spec.tone : undefined}>
    <div className="meeting-item-grid">
      <StatusIcon spec={spec} />
      <Stack gap={6} className="meeting-item-body">
        <Stack gap={2}>
          <Text fw={600} id={textId}>{item.text}</Text>
          <div className="row-sub meeting-meta">
            {flag && <strong className="meeting-flag">{flag}</strong>}
            {(kindLabel || statusLabel) && <StatusMark spec={spec}>{[kindLabel, statusLabel].filter(Boolean).join(" · ")}</StatusMark>}
            {due && <span className={kindLabel || statusLabel || flag ? "row-sep" : undefined}>{due}</span>}
            {showProject && <span className="row-sep">{item.projectName ?? "No project"}</span>}
            {showMeeting && <span className="row-sep">{item.meetingTitle}, {shortDay(item.meetingAt)}</span>}
          </div>
        </Stack>
        <blockquote className="meeting-quote">
          <span className="meeting-quote-who">{item.speaker}<br /><span className="meeting-quote-time">{timestamp(item.atSeconds)}</span></span>
          <span className="meeting-quote-text">“{item.quote}”{item.meetingUrl ? <> <a className="meeting-quote-link" href={item.meetingUrl} target="_blank" rel="noopener noreferrer">Open in Fathom<ExternalLink size={12} aria-hidden="true" /></a></> : null}</span>
        </blockquote>
        {item.feature && <details className="quiet-details"><summary>Idea: {item.feature.title}</summary><Stack gap={4}><Text size="sm">{item.feature.outcome}</Text><ul className="meeting-checks">{item.feature.acceptance.map(check => <li key={check}><Text size="sm">{check}</Text></li>)}</ul></Stack></details>}
        {item.statusNote && (item.status === "looks_done" || item.status === "planned" || item.statusSource !== "model") && <Text size="sm" c="dimmed">{item.statusNote}</Text>}
        {item.status === "planned" && item.agentRunId && <Group><Button component="a" variant="default" leftSection={<Bot size={16} aria-hidden="true" />} href={routeLink("agents", { return: returnTo }, item.agentRunId)}>View agent run</Button></Group>}
        {actions.length > 0 && <Group gap="xs">{actions}</Group>}
      </Stack>
    </div>
  </li>;
}
