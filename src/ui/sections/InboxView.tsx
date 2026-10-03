import type { ReactNode } from "react";
import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { AlarmClock, Archive, Check, CircleDot, CircleSlash, Clock, Undo2 } from "lucide-react";
import type { AttentionAction, InboxItem } from "../../shared/types.ts";
import { EvidenceList } from "../components/EvidenceList.tsx";
import { StatusMark } from "../components/Status.tsx";
import { relative } from "../format.ts";
import { inboxKindLabel } from "../inbox-model.ts";
import { INBOX_KIND, type StatusSpec } from "../status.ts";

const HISTORY_STATE: Readonly<Record<"obsolete" | "snoozed" | "handled" | "dismissed" | "current", StatusSpec>> = {
  obsolete: { tone: "gray", icon: Archive, label: "No longer current" },
  snoozed: { tone: "blue", icon: Clock, label: "Snoozed" },
  handled: { tone: "green", icon: Check, label: "Handled locally" },
  dismissed: { tone: "gray", icon: CircleSlash, label: "Not relevant" },
  current: { tone: "amber", icon: CircleDot, label: "Current" },
};
const historyState = (item: InboxItem): keyof typeof HISTORY_STATE =>
  !item.active ? "obsolete" : item.snoozedUntil ? "snoozed" : item.status === "acknowledged" ? "handled" : item.status === "dismissed" ? "dismissed" : "current";

export function InboxView({ items, onResolve, busyId, history = false, compact = false, actions }: {
  items: InboxItem[];
  onResolve: (id: string, action: AttentionAction) => void;
  busyId: string | null;
  history?: boolean;
  compact?: boolean;
  actions?: (item: InboxItem) => ReactNode;
}) {
  return <Stack gap="sm">{items.map((item) => {
    const kind = INBOX_KIND[item.kind];
    const state = historyState(item);
    return <Card key={item.id} withBorder={!compact} radius="md" padding={compact ? 0 : "md"} data-attention-id={item.id} className="attention-card" data-tone={history ? HISTORY_STATE[state].tone : kind.tone}>
      <Stack gap="sm">
        <div className="status-line">
          <StatusMark spec={kind} strong>{inboxKindLabel(item.kind)}</StatusMark>
          {history && <StatusMark spec={HISTORY_STATE[state]}>{state === "snoozed" && item.snoozedUntil ? `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}` : state === "obsolete" ? "No longer current; Undo cannot revive obsolete evidence." : HISTORY_STATE[state].label}</StatusMark>}

        </div>
        {!compact && <Text fw={600}>{item.title}</Text>}
        {item.detail && <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.detail}</Text>}
        {item.nextStep && <Text size="sm" className="attention-next"><span className="section-label">Next</span> {item.nextStep}</Text>}
        <Group gap="xs" className="decision-bar">
          {history ? <Button variant="default" leftSection={<Undo2 size={16} aria-hidden="true" />} disabled={!!busyId} onClick={() => onResolve(item.id, "undo")}>Undo</Button> : <>
            <Button leftSection={<Check size={16} aria-hidden="true" />} disabled={!!busyId} loading={busyId === item.id} onClick={() => onResolve(item.id, "handled")}>Handled</Button>
            <Button variant="default" leftSection={<AlarmClock size={16} aria-hidden="true" />} disabled={!!busyId} onClick={() => onResolve(item.id, "tomorrow")}>Tomorrow</Button>
            <Button variant="subtle" color="gray" leftSection={<CircleSlash size={16} aria-hidden="true" />} disabled={!!busyId} onClick={() => onResolve(item.id, "dismiss")}>Not relevant</Button>
          </>}
        </Group>
        {!history && <Text size="xs" c="dimmed">Handled remembers this evidence locally. It does not complete upstream work.</Text>}
        {actions?.(item)}
        <Text size="xs" c="dimmed">Source {relative(item.evidence[0]?.observedAt ?? null)} · Last observed {relative(item.lastObservedAt)}</Text>
        <details className="quiet-details"><summary>Evidence ({item.evidence.length})</summary><EvidenceList evidence={item.evidence} /></details>
      </Stack>
    </Card>;
  })}</Stack>;
}
