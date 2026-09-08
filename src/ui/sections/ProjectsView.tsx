import { Anchor, Button, Card, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import type { InboxItem, PortfolioProject } from "../../shared/types.ts";
import { hasHumanRequest } from "../../core/relevance.ts";
import { ProjectCard } from "./ProjectCard.tsx";
import { CopyText } from "../components/CopyText.tsx";
import { handoff } from "../format.ts";

export function ProjectsView({ projects, items, query, selectedId, waiting, onSearch, busyId, onOverride, onCorrect }: {
  projects: PortfolioProject[]; items: InboxItem[]; query: string; selectedId: string | null; waiting: boolean;
  onSearch: (query: string) => void; busyId: string | null;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: string, value: string) => void;
}) {
  const selected = projects.find((p) => p.id === selectedId);
  const q = query.toLocaleLowerCase();
  const filtered = projects.filter((p) => (!waiting || (!p.override.hidden && hasHumanRequest(p))) &&
    `${p.name} ${p.canonicalPath}`.toLocaleLowerCase().includes(q));
  const destination = (id?: string) => `#projects?${new URLSearchParams({ q: query, ...(waiting ? { waiting: "1" } : {}), ...(id ? { id } : {}) })}`;
  return <Stack gap="sm">
    <Title order={2}>Projects</Title>
    <TextInput label="Search projects by name or full path" value={query} onChange={(e) => onSearch(e.currentTarget.value)} />
    {waiting && <Group><Text size="sm">Showing unresolved human-request projects, including unchecked ones.</Text><Anchor href="#projects">Show every project</Anchor></Group>}
    <Text role="status" size="sm">{filtered.length} matching projects</Text>
    {selectedId && !selected && <Text role="status">This project is not in the saved directory. Refresh to retry.</Text>}
    {selected && <section aria-label={`Project details: ${selected.name}`}>
      <Stack gap="sm">
        <Group><Button component="a" href={destination()} variant="default">Close details</Button><CopyText text={selected.canonicalPath} label="Copy path" /></Group>
        <Text size="sm">Coverage: {selected.scanStatus ?? "cached"}. Summary generated {new Date(selected.summary.generatedAt).toLocaleString()}.</Text>
        {items.filter((i) => i.projectId === selected.id).slice(0, 3).map((item) => <Stack key={item.id} gap={4}><Text size="sm">{item.detail}</Text><CopyText text={handoff(selected, item)} label="Copy handoff" /></Stack>)}
        <ProjectCard project={selected} busy={busyId === selected.id} onOverride={onOverride} onCorrect={onCorrect} />
      </Stack>
    </section>}
    {!filtered.length && <Text>No matching projects. Clear the search to see the directory.</Text>}
    {filtered.map((p) => <Card key={p.id} withBorder radius="md" padding="sm">
      <Group justify="space-between" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Anchor href={destination(p.id)} aria-expanded={selectedId === p.id}>{p.name}</Anchor>
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{p.canonicalPath}</Text>
          <Text size="xs">{p.scanStatus ?? "cached"}{p.override.hidden ? " · hidden" : ""}{p.override.pinned ? " · pinned" : ""}{hasHumanRequest(p) ? " · human request inferred" : ""}</Text>
        </Stack>
      </Group>
    </Card>)}
  </Stack>;
}
