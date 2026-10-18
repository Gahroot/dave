/** Port of src/ui/sections/ProjectWorkspace.tsx: Work (delivery, meetings) and Reference (notes, sources). */
import { useState } from "react";
import { View } from "react-native";
import { router, Stack as RouterStack } from "expo-router";
import { ChevronLeft, Clock, EyeOff, Target } from "lucide-react-native";
import type { InboxItem, PortfolioProject } from "../../../../src/shared/types.ts";
import { handoff, projectWorkBrief, relative } from "../../../../src/ui/format.ts";
import { FRESHNESS } from "../../../../src/ui/status.ts";
import { findProject, usePortfolio } from "../../lib/portfolio";
import { Banner, Button, CopyButton, Disclosure, EmptyState, ErrorState, Inline, LoadingState, Panel, Screen, Segmented, Small, Stack } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { ProjectDeliveryPanel } from "../delivery/ProjectDeliveryPanel";
import { ProjectMeetingsPanel } from "../meetings/ProjectMeetingsPanel";
import { scanOf } from "./model";
import { ProjectNotes, ProjectOptions, ProjectSources } from "./ProjectNotes";
import { useProjectActions } from "./useProjectActions";

type Tab = "work" | "reference";

function Unavailable() {
  return <Screen>
    <RouterStack.Screen options={{ title: "Project" }} />
    <EmptyState title="Project unavailable" message="This project is not in the saved directory. Refresh to retry."
      action={<Button title="Back to projects" icon={ChevronLeft} onPress={() => router.canGoBack() ? router.back() : router.replace("/projects")} />} />
  </Screen>;
}

export function ProjectWorkspaceScreen({ id }: { id: string | null }) {
  const resource = usePortfolio();
  const { data: portfolio, error, loading, refreshing, reload } = resource;
  const actions = useProjectActions(resource);
  const [tab, setTab] = useState<Tab>("work");
  if (!id) return <Unavailable />;
  if (!portfolio) return loading || !error ? <Screen><LoadingState label="Loading project…" /></Screen>
    : <Screen><ErrorState message={error} onRetry={() => void reload()} /></Screen>;
  const project = findProject(portfolio, id);
  if (!project) return <Unavailable />;
  const busy = actions.busyId === project.id;
  const items = portfolio.inbox.filter((item) => item.projectId === project.id).slice(0, 3);

  return <Screen refreshing={refreshing} onRefresh={() => void reload()}>
    <RouterStack.Screen options={{ title: project.name }} />
    {error && <Banner tone="red" title="Couldn't refresh" message={`${error} Showing the last loaded snapshot.`} />}
    {actions.error && <Banner tone="red" title="Action failed" message={actions.error} action={<Button compact variant="subtle" title="Dismiss" onPress={actions.clearError} />} />}
    <Inline>
      <Button title="Open focus" icon={Target} compact onPress={() => router.push(`/focus/${project.id}`)} />
      <CopyButton text={project.canonicalPath} label="Copy path" />
    </Inline>
    {project.override.hidden && <StatusMark spec={{ tone: "gray", icon: EyeOff, label: "" }}>Hidden project: still available through this direct link.</StatusMark>}
    <Segmented<Tab> label="Project workspace" value={tab} onChange={setTab} options={[{ value: "work", label: "Work" }, { value: "reference", label: "Reference" }]} />
    {/* Both tabs stay mounted (the web's keepMounted) so an open note draft survives a tab switch. */}
    <View style={tab === "work" ? undefined : { display: "none" }}><Stack gap={16}>
      <ProjectDeliveryPanel project={project} />
      <ProjectMeetingsPanel projectId={project.id} />
    </Stack></View>
    <View style={tab === "reference" ? undefined : { display: "none" }}>
      <Reference project={project} busy={busy} items={items} actions={actions} />
    </View>
  </Screen>;
}

function Reference({ project, busy, items, actions }: {
  project: PortfolioProject; busy: boolean; items: InboxItem[];
  actions: ReturnType<typeof useProjectActions>;
}) {
  const onOverride = (id: string, next: { pinned?: boolean; hidden?: boolean }) => { void actions.override(id, next); };
  return <Stack gap={16}>
    <Inline>
      <StatusMark spec={FRESHNESS[scanOf(project)]} />
      <StatusMark spec={{ tone: "gray", icon: Clock, label: "" }}>{`Summary ${relative(project.summary.generatedAt)}`}</StatusMark>
    </Inline>
    <Panel title="Project notes" note="Corrections are yours: they survive regeneration.">
      <ProjectOptions project={project} busy={busy} onOverride={onOverride} />
      <ProjectNotes project={project} busy={busy} onOverride={onOverride} onCorrect={actions.correct} />
      <CopyButton text={projectWorkBrief(project)} label="Copy project notes (context only)" />
    </Panel>
    <Panel>
      <Disclosure title="Sources and context">
        <Small strong>Source details</Small>
        <ProjectSources project={project} />
        {items.map((item) => <Stack key={item.id} gap={4}>
          <Small selectable>{item.detail}</Small>
          <CopyButton text={handoff(project, item)} label="Copy handoff" />
        </Stack>)}
      </Disclosure>
    </Panel>
  </Stack>;
}
