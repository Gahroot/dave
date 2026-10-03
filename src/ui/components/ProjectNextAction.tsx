import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { ArrowRight, CircleAlert } from "lucide-react";
import type { Portfolio, PortfolioProject } from "../../shared/types.ts";
import { clean, projectWorkBrief, relative } from "../format.ts";
import { CopyText } from "./CopyText.tsx";
import { StatusIcon, StatusMark } from "./Status.tsx";
import { FRESHNESS } from "../status.ts";

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
      <Text size="xs" c="dimmed" className="section-label">Chosen next action · {clean(p.name, 200)}</Text>
      <Title order={2} size="h4" className="step-headline"><StatusIcon spec={{ tone: "blue", icon: ArrowRight, label: "" }} />{clean(p.summary.suggestedNextAction ?? "", 400)}</Title>
      {p.summary.recentFocus && <Text size="sm" c="dimmed">{clean(p.summary.recentFocus, 400)}</Text>}
      {p.summary.unfinished && <StatusMark spec={{ tone: "amber", icon: CircleAlert, label: "" }}>Blocked / unfinished: {clean(p.summary.unfinished, 400)}</StatusMark>}
      <div className="status-line"><StatusMark spec={FRESHNESS[p.scanStatus ?? "cached"]} /><Text size="xs" c="dimmed">Action saved {relative(p.summary.nextActionEditedAt!)}</Text></div>
      <Group gap="xs">
        <Button component="a" href={`#projects?id=${encodeURIComponent(p.id)}`} rightSection={<ArrowRight size={16} aria-hidden="true" />}>View/update project</Button>
        <CopyText text={projectWorkBrief(p)} label="Copy work brief" />
      </Group>
    </Stack>
  </Card>;
}
