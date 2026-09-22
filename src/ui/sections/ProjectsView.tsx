import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import type { InboxItem, PortfolioProject, ProjectSummary } from "../../shared/types.ts";
import { hasHumanRequest } from "../../core/relevance.ts";
import { ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
import { parseRoute, routeLink } from "../navigation.ts";

export function ProjectsView({ projects, items, query, selectedId, waiting, onSearch, busyId, onOverride, onCorrect, route }: {
  projects: PortfolioProject[]; items: InboxItem[]; query: string; selectedId: string | null; waiting: boolean; route: string;
  onSearch: (query: string) => void; busyId: string | null;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: string, value: string) => Promise<ProjectSummary | null>;
}) {
  const navigation = parseRoute(route);
  const selected = projects.find(project => project.id === selectedId);
  const q = query.toLocaleLowerCase();
  const filtered = projects.filter(project => (navigation.hidden ? project.override.hidden : !project.override.hidden) && (!waiting || hasHumanRequest(project)) && `${project.name} ${project.canonicalPath}`.toLocaleLowerCase().includes(q)).sort((a, b) => Number(b.override.pinned) - Number(a.override.pinned));
  const destination = (id?: string) => routeLink("projects", { q: query, waiting, hidden: navigation.hidden, id });
  return <Stack gap="md" className="projects-view" data-has-selection={!!selectedId}>
    <PageHeader title="Projects" />
    <div className="project-directory-toolbar"><TextInput aria-label="Search projects by name or full path" placeholder="Search projects by name or path" value={query} onChange={e => onSearch(e.currentTarget.value)} />
    <Group gap="xs"><Button component="a" variant="default" href={routeLink("projects", { q: query, id: selectedId, waiting: !waiting, hidden: navigation.hidden })} aria-pressed={waiting}>Waiting for me</Button><Button component="a" variant="default" href={routeLink("projects", { q: query, id: selectedId, hidden: !navigation.hidden, waiting })} aria-pressed={navigation.hidden}>Hidden projects</Button><Text role="status" size="sm">{filtered.length} matching projects</Text></Group></div>
    <div className={`workspace-split${selectedId ? " has-selection" : ""}`}>
      <div className="workspace-list" aria-label="Project directory">
        {!filtered.length && <EmptyState title="No matching projects" action={<Button component="a" href="#projects" variant="default">Clear filters</Button>} />}
        {filtered.map(project => <a className="workspace-row" key={project.id} id={`project-row-${project.id}`} aria-label={project.name} href={destination(project.id)} aria-current={selectedId === project.id ? "true" : undefined}><Text fw={600}>{project.name}</Text><Text className="project-directory-next" size="sm" c="dimmed">{project.summary.suggestedNextAction || "No next action recorded"}</Text><Text size="xs">{project.scanStatus ?? "cached"}{project.override.hidden ? " · hidden" : ""}{project.override.pinned ? " · pinned" : ""}{hasHumanRequest(project) ? " · human request inferred" : ""}</Text><Text className="project-directory-path" title={project.canonicalPath} size="xs" c="dimmed">{project.canonicalPath}</Text></a>)}
      </div>
      {selected ? <ProjectWorkspace key={selected.id} project={selected} items={items} route={route} busy={busyId === selected.id} onOverride={onOverride} onCorrect={onCorrect} /> : selectedId ? <EmptyState title="Project unavailable" action={<Button component="a" href={destination()} variant="default">Back to projects</Button>}>This project is not in the saved directory. Refresh to retry.</EmptyState> : <EmptyState title="Choose a project">See its next action, delivery work and supporting context.</EmptyState>}
    </div>
  </Stack>;
}
