import { useEffect, useState } from "react";
import { Button, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import type { InboxItem, PortfolioProject, ProjectSummary } from "../../shared/types.ts";
import { ProjectCard } from "./ProjectCard.tsx";
import { LazyDeliveryView as DeliveryView } from "./LazyDeliveryView.tsx";
import { CopyText } from "../components/CopyText.tsx";
import { handoff, projectWorkBrief } from "../format.ts";
import { parseRoute, routeLink } from "../navigation.ts";


export function ProjectWorkspace({ project, items, route, busy, onOverride, onCorrect }: {
  project: PortfolioProject; items: InboxItem[]; route: string; busy: boolean;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: string, value: string) => Promise<ProjectSummary | null>;
}) {
  const navigation = parseRoute(route);
  const [deliveryVisited, setDeliveryVisited] = useState(navigation.tab === "delivery");
  useEffect(() => { if (navigation.tab === "delivery") setDeliveryVisited(true); }, [navigation.tab]);
  const link = (tab?: string) => routeLink("projects", { q: navigation.q, waiting: navigation.waiting, hidden: navigation.hidden, id: tab ? project.id : null, tab });
  return <section className="workspace-detail" aria-label={`Project details: ${project.name}`}><Stack gap="md">
    <Group justify="space-between"><Button component="a" href={link()} variant="default" onClick={() => requestAnimationFrame(() => document.getElementById(`project-row-${project.id}`)?.focus())}>Close details</Button><CopyText text={project.canonicalPath} label="Copy path" /></Group>
    <div><Title order={3}>{project.name}</Title><Text size="sm" c="dimmed">{project.scanStatus ?? "cached"} · Summary {new Date(project.summary.generatedAt).toLocaleString()}</Text></div>

    <Tabs value={navigation.tab} onChange={tab => { if (tab) location.hash = link(tab); }} keepMounted>
      <Tabs.List aria-label="Project workspace"><Tabs.Tab value="overview">Overview</Tabs.Tab><Tabs.Tab value="delivery">Delivery</Tabs.Tab><Tabs.Tab value="context">Context</Tabs.Tab></Tabs.List>
      <Tabs.Panel value={navigation.tab === "context" ? "context" : "overview"} pt="md"><Stack gap="md"><ProjectCard project={project} busy={busy} onOverride={onOverride} onCorrect={onCorrect} section={navigation.tab === "context" ? "context" : "overview"} /><CopyText text={projectWorkBrief(project)} label="Copy project notes (context only)" />{navigation.tab === "context" && items.filter(item => item.projectId === project.id).slice(0, 3).map(item => <Stack key={item.id} gap={4}><Text size="sm">{item.detail}</Text><CopyText text={handoff(project, item)} label="Copy handoff" /></Stack>)}</Stack></Tabs.Panel>
      <Tabs.Panel value="delivery" pt="md">{deliveryVisited && <DeliveryView project={project} />}</Tabs.Panel>

    </Tabs>
  </Stack></section>;
}
