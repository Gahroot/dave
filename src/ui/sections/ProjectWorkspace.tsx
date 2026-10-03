import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Group, Stack, Tabs, Text } from "@mantine/core";
import type { InboxItem, PortfolioProject, ProjectSummary } from "../../shared/types.ts";
import { ProjectCard } from "./ProjectCard.tsx";
import { LazyDeliveryView as DeliveryView } from "./LazyDeliveryView.tsx";
import { CopyText } from "../components/CopyText.tsx";
import { handoff, projectWorkBrief } from "../format.ts";
import { parseRoute, routeLink } from "../navigation.ts";
import { DetailHeader } from "../components/WorkspacePrimitives.tsx";
import { StatusMark } from "../components/Status.tsx";
import { FRESHNESS } from "../status.ts";
import { relative } from "../format.ts";
import { ChevronLeft, Clock, EyeOff } from "lucide-react";
// Loads with the Work tab, like delivery; renders nothing for projects without meetings.
const ProjectMeetings = lazy(() => import("./ProjectMeetings.tsx").then(m => ({ default: m.ProjectMeetings })));


export function ProjectWorkspace({ project, items, route, busy, onOverride, onCorrect }: {
  project: PortfolioProject; items: InboxItem[]; route: string; busy: boolean;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: string, value: string) => Promise<ProjectSummary | null>;
}) {
  const navigation = parseRoute(route);
  const [deliveryVisited, setDeliveryVisited] = useState(navigation.tab === "delivery");
  useEffect(() => { if (navigation.tab === "delivery") setDeliveryVisited(true); }, [navigation.tab]);
  const [sourcesOpen, setSourcesOpen] = useState(navigation.tab === "context");
  useEffect(() => { if (navigation.tab === "context") setSourcesOpen(true); }, [navigation.tab]);
  const link = (tab?: string) => routeLink("projects", { q: navigation.q, waiting: navigation.waiting, hidden: navigation.hidden, id: tab ? project.id : null, tab, return: tab ? navigation.returnTo : null });
  return <section className="project-workspace" aria-label={`Project details: ${project.name}`}><Stack gap="md">
    <DetailHeader title={project.name} back={link()} backLabel="Back to projects"><Group gap="xs">{navigation.returnTo && <Button component="a" variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} href={navigation.returnTo} data-workspace-back>Back to inbox item</Button>}<CopyText text={project.canonicalPath} label="Copy path" /></Group></DetailHeader>

    {project.override.hidden && <Text role="status" size="sm" className="status-line"><StatusMark spec={{ tone: "gray", icon: EyeOff, label: "" }}>Hidden project: still available through this direct link.</StatusMark></Text>}
    <Tabs value={navigation.tab === "delivery" ? "delivery" : "overview"} onChange={tab => { if (tab) location.hash = link(tab); }} keepMounted>
      <Tabs.List aria-label="Project workspace"><Tabs.Tab value="delivery">Work</Tabs.Tab><Tabs.Tab value="overview">Reference</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="overview" pt="md"><Stack gap="md">
        <div className="status-line"><StatusMark spec={FRESHNESS[project.scanStatus ?? "cached"]} /><StatusMark spec={{ tone: "gray", icon: Clock, label: "" }}><span title={new Date(project.summary.generatedAt).toLocaleString()}>Summary {relative(project.summary.generatedAt)}</span></StatusMark></div>
        <ProjectCard project={project} busy={busy} onOverride={onOverride} onCorrect={onCorrect} section="overview" />
        <CopyText text={projectWorkBrief(project)} label="Copy project notes (context only)" />
        <details className="quiet-details" open={sourcesOpen} onToggle={event => setSourcesOpen(event.currentTarget.open)}><summary>Sources and context</summary><Stack gap="md"><ProjectCard project={project} busy={busy} onOverride={onOverride} onCorrect={onCorrect} section="context" />{items.filter(item => item.projectId === project.id).slice(0, 3).map(item => <Stack key={item.id} gap={4}><Text size="sm">{item.detail}</Text><CopyText text={handoff(project, item)} label="Copy handoff" /></Stack>)}</Stack></details>
      </Stack></Tabs.Panel>
      <Tabs.Panel value="delivery" pt="md">{deliveryVisited && <Stack gap="xl"><DeliveryView project={project} /><Suspense fallback={null}><ProjectMeetings projectId={project.id} returnTo={link("delivery")} /></Suspense></Stack>}</Tabs.Panel>

    </Tabs>
  </Stack></section>;
}
