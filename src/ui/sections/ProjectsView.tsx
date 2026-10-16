import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { ChevronLeft, EyeOff, Folder, Lightbulb, Pin, Search, UserRound } from "lucide-react";
import type { InboxItem, PortfolioProject, ProjectSummary } from "../../shared/types.ts";
import { hasHumanRequest } from "../../core/relevance.ts";
import { ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
import { StatusIcon, StatusMark } from "../components/Status.tsx";
import { FRESHNESS, hasRail, type StatusSpec } from "../status.ts";
import { parseRoute, routeLink } from "../navigation.ts";

const INFERRED: StatusSpec = { tone: "violet", icon: Lightbulb, label: "Human request inferred" };
const PINNED: StatusSpec = { tone: "blue", icon: Pin, label: "Pinned" };
const HIDDEN: StatusSpec = { tone: "gray", icon: EyeOff, label: "Hidden" };
const PROJECT: StatusSpec = { tone: "gray", icon: Folder, label: "Project" };
/** The one state a row leads with, most urgent first: unreadable, a person may be waiting, stale, then your own marks. */
const leadSpec = (project: PortfolioProject, inferred: boolean): StatusSpec => {
  const scan = project.scanStatus ?? "cached";
  if (scan === "unavailable") return FRESHNESS.unavailable;
  if (inferred) return INFERRED;
  if (scan === "cached") return FRESHNESS.cached;
  if (project.override.pinned) return PINNED;
  return project.override.hidden ? HIDDEN : PROJECT;
};
/** Middle-truncate a path so the project folder name, the part people recognise, stays visible. */
const shortPath = (path: string, keep = 2) => { const parts = path.split("/").filter(Boolean); return parts.length > keep + 1 ? `…/${parts.slice(-keep).join("/")}` : path; };

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
  if (selectedId || navigation.invalidSelection) return <div className="projects-view focused-workspace">{selected ? <ProjectWorkspace key={selected.id} project={selected} items={items} route={route} busy={busyId === selected.id} onOverride={onOverride} onCorrect={onCorrect} /> : <EmptyState title="Project unavailable" action={<Button component="a" href={destination()} variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} data-workspace-back>Back to projects</Button>}>This project is not in the saved directory. Refresh to retry.</EmptyState>}</div>;
  const visible = projects.filter(project => navigation.hidden ? project.override.hidden : !project.override.hidden);
  const fresh = { checked: 0, cached: 0, unavailable: 0 };
  for (const project of visible) fresh[project.scanStatus ?? "cached"] += 1;
  return <Stack gap="md" className="projects-view">
    <PageHeader title="Projects" />
    <div className="count-strip" role="group" aria-label="Data freshness">
      {(["checked", "cached", "unavailable"] as const).filter(key => fresh[key]).map(key => <StatusMark key={key} spec={FRESHNESS[key]}><strong>{fresh[key]}</strong> {FRESHNESS[key].label.toLowerCase()}</StatusMark>)}
    </div>
    <div className="project-directory-toolbar"><TextInput aria-label="Search projects by name or full path" placeholder="Search projects by name or path" leftSection={<Search size={16} aria-hidden="true" />} value={query} onChange={e => onSearch(e.currentTarget.value)} />
    <Group gap="xs"><Button component="a" variant={waiting ? "filled" : "default"} leftSection={<UserRound size={16} aria-hidden="true" />} href={routeLink("projects", { q: query, id: selectedId, waiting: !waiting, hidden: navigation.hidden })} aria-pressed={waiting}>Waiting for me</Button><Button component="a" variant={navigation.hidden ? "filled" : "default"} leftSection={<EyeOff size={16} aria-hidden="true" />} href={routeLink("projects", { q: query, id: selectedId, hidden: !navigation.hidden, waiting })} aria-pressed={navigation.hidden}>Hidden projects</Button><Text role="status" size="sm" c="dimmed">{filtered.length} matching projects</Text></Group></div>
    <div>
      <div className="workspace-list app-panel" aria-label="Project directory">
        {!filtered.length && <EmptyState title="No matching projects" action={<Button component="a" href="#projects" variant="default">Clear filters</Button>} />}
        {filtered.map(project => {
          const scan = project.scanStatus ?? "cached";
          const inferred = hasHumanRequest(project);
          // Show exceptions, not defaults: checked rows carry no freshness tag, the header already counts them.
          // The lead tile repeats the most urgent tag in colour; the words stay in the tags line below.
          return <a className="workspace-row" key={project.id} id={`project-row-${project.id}`} data-workspace-focus={`project:${project.id}`} aria-label={project.name} href={destination(project.id)} aria-current={selectedId === project.id ? "true" : undefined} data-tone={scan === "unavailable" && hasRail("red") ? "red" : undefined}>
            <span className="row-main">
              <StatusIcon spec={leadSpec(project, inferred)} />
              <span className="row-title">{project.name}</span>
              <span className="row-aside project-directory-path" title={project.canonicalPath}>{shortPath(project.canonicalPath, 1)}</span>
              <span className="row-sub project-directory-next">{project.summary.suggestedNextAction || "No next action recorded"}</span>
              {(scan !== "checked" || inferred || project.override.pinned || project.override.hidden) && <span className="row-sub row-tags">
                {scan !== "checked" && <StatusMark spec={FRESHNESS[scan]} />}
                {project.override.pinned && <StatusMark spec={PINNED} />}
                {project.override.hidden && <StatusMark spec={HIDDEN} />}
                {inferred && <StatusMark spec={INFERRED} />}
              </span>}
            </span>
          </a>;
        })}
      </div>
    </div>
  </Stack>;
}
