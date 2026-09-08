import type { ReactNode } from "react";
import { Button, Card, Group, Stack, Text } from "@mantine/core";
import type { AttentionAction, InboxItem } from "../../shared/types.ts";
import { EvidenceList } from "../components/EvidenceList.tsx";
import { relative } from "../format.ts";

export function InboxView({ items, onResolve, busyId, history = false, actions }: {
  items: InboxItem[];
  onResolve: (id: string, action: AttentionAction) => void;
  busyId: string | null;
  history?: boolean;
  actions?: (item: InboxItem) => ReactNode;
}) {
  return <Stack gap="sm">{items.map((item) => <Card key={item.id} withBorder radius="md" padding="md" data-attention-id={item.id}>
    <Stack gap="xs">
      <Text size="xs">{item.kind === "inspection" ? "Inspection suggestion" : "Human request inferred from task text"}</Text>
      <Text fw={600}>{item.title}</Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.detail}</Text>
      <Text size="sm">{item.nextStep}</Text>
      <Text size="xs" c="dimmed">Source {relative(item.evidence[0]?.observedAt ?? null)} · Last observed {relative(item.lastObservedAt)}</Text>
      {history && <Text size="sm">{!item.active ? "No longer current; Undo cannot revive obsolete evidence." :
        item.snoozedUntil ? `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}` :
        item.status === "acknowledged" ? "Handled locally" : item.status === "dismissed" ? "Not relevant" : "Current"}</Text>}
      {actions?.(item)}
      <Group gap="xs">
        {history ? <Button variant="default" disabled={!!busyId} onClick={() => onResolve(item.id, "undo")}>Undo</Button> : <>
          <Button disabled={!!busyId} loading={busyId === item.id} onClick={() => onResolve(item.id, "handled")}>Handled</Button>
          <Button variant="default" disabled={!!busyId} onClick={() => onResolve(item.id, "tomorrow")}>Tomorrow</Button>
          <Button variant="default" disabled={!!busyId} onClick={() => onResolve(item.id, "dismiss")}>Not relevant</Button>
        </>}
      </Group>
      <details><summary>Evidence</summary><EvidenceList evidence={item.evidence} /></details>
    </Stack>
  </Card>)}</Stack>;
}
