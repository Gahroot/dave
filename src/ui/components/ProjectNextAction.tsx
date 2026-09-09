import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import type { Portfolio, PortfolioProject } from "../../shared/types.ts";
import { clean, projectWorkBrief } from "../format.ts";
import { CopyText } from "./CopyText.tsx";

export function selectProjectNextAction(portfolio: Pick<Portfolio, "active" | "other">): PortfolioProject | undefined {
  return [...portfolio.active, ...portfolio.other].find((p) => p.override.pinned && !p.override.hidden &&
    p.summary.edited && Boolean(p.summary.suggestedNextAction?.trim()) &&
    Boolean(p.summary.nextActionEditedAt) && Number.isFinite(Date.parse(p.summary.nextActionEditedAt ?? "")));
}

export function ProjectNextAction({ portfolio }: { portfolio: Portfolio }) {
  const p = selectProjectNextAction(portfolio);
  if (!p) return null;
  return <Card withBorder radius="md" padding="md">
    <Stack gap="xs">
      <Title order={2} size="h4">Chosen next action</Title>
      <Text fw={600}>{clean(p.name, 200)}</Text>
      <Text>{clean(p.summary.suggestedNextAction ?? "", 400)}</Text>
      {p.summary.recentFocus && <Text size="sm" c="dimmed">{clean(p.summary.recentFocus, 400)}</Text>}
      {p.summary.unfinished && <Text size="sm">Blocked / unfinished: {clean(p.summary.unfinished, 400)}</Text>}
      <Text size="xs" c="dimmed">Action saved {new Date(p.summary.nextActionEditedAt!).toLocaleString()} · Coverage: {p.scanStatus ?? "cached"}</Text>
      <Group gap="xs">
        <Button component="a" href={`#projects?id=${encodeURIComponent(p.id)}`} variant="default">View/update project</Button>
        <CopyText text={projectWorkBrief(p)} label="Copy work brief" />
      </Group>
    </Stack>
  </Card>;
}
