/** Port of src/ui/sections/ProjectsView.tsx: search, Waiting/Hidden filters, grouped directory. */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { EyeOff, Search, UserRound } from "lucide-react-native";
import { FRESHNESS } from "../../../../src/ui/status.ts";
import { allProjects, usePortfolio } from "../../lib/portfolio";
import { Banner, Button, EmptyState, ErrorState, Inline, LoadingState, Muted, Panel, Row, Screen, TextField } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { space } from "../../ui/theme";
import { StaleBadge } from "./Labels";
import { freshnessCounts, groupProjects, leadSpec, rowTags, shortPath } from "./model";
import { ProjectNextAction } from "./ProjectNextAction";

export function ProjectsScreen() {
  const params = useLocalSearchParams<{ waiting?: string; hidden?: string; q?: string }>();
  const resource = usePortfolio();
  const { data: portfolio, error, loading, refreshing, reload } = resource;
  const [query, setQuery] = useState(typeof params.q === "string" ? params.q : "");
  const waiting = params.waiting === "1";
  const hidden = params.hidden === "1";
  const setFilter = (key: "waiting" | "hidden", on: boolean) => router.setParams({ [key]: on ? "1" : undefined });

  if (!portfolio) return loading || !error ? <Screen><LoadingState label="Loading projects…" /></Screen>
    : <Screen><ErrorState message={error} onRetry={() => void reload()} /></Screen>;

  const filters = { query, waiting, hidden };
  const groups = groupProjects(portfolio, filters);
  const total = groups.reduce((n, g) => n + g.projects.length, 0);
  const fresh = freshnessCounts(allProjects(portfolio), hidden);
  const clear = () => { setQuery(""); router.setParams({ waiting: undefined, hidden: undefined, q: undefined }); };

  return <Screen refreshing={refreshing} onRefresh={() => void reload()}>
    {error && <Banner tone="red" title="Couldn't refresh projects" message={`${error} Showing the last loaded snapshot.`} />}
    {portfolio.stale && <StaleBadge label="Snapshot may be out of date" why={portfolio.refreshError ?? "The last rescan has not finished; projects show cached data."} />}
    {!waiting && !hidden && !query && <ProjectNextAction portfolio={portfolio} />}
    <View style={styles.toolbar}>
      <View accessible accessibilityLabel={`Data freshness: ${(["checked", "cached", "unavailable"] as const).map((k) => `${fresh[k]} ${k}`).join(", ")}`}><Inline>
        {(["checked", "cached", "unavailable"] as const).filter((k) => fresh[k]).map((k) =>
          <StatusMark key={k} spec={FRESHNESS[k]} strong>{`${fresh[k]} ${FRESHNESS[k].label.toLowerCase()}`}</StatusMark>)}
      </Inline></View>
      <TextField label="Search projects" placeholder="Search projects by name or path" value={query} onChangeText={setQuery}
        autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" help="Matches name or full path" />
      <Inline>
        <Button title="Waiting for me" icon={UserRound} compact variant={waiting ? "primary" : "secondary"}
          accessibilityLabel={`Waiting for me, ${waiting ? "on" : "off"}`} onPress={() => setFilter("waiting", !waiting)} />
        <Button title="Hidden projects" icon={EyeOff} compact variant={hidden ? "primary" : "secondary"}
          accessibilityLabel={`Hidden projects, ${hidden ? "on" : "off"}`} onPress={() => setFilter("hidden", !hidden)} />
      </Inline>
      <Muted>{`${total} matching projects`}</Muted>
    </View>
    {!total && <Panel><EmptyState title="No matching projects" icon={Search} action={<Button title="Clear filters" onPress={clear} />} /></Panel>}
    {groups.map((group) => <Panel key={group.key} title={group.title} count={group.projects.length} padded={false}>
      {group.projects.map((project) => {
        const lead = leadSpec(project);
        const tags = rowTags(project);
        return <Row key={project.id} title={project.name} spec={lead} showRail={lead.tone === "red"}
          accessibilityHint="Opens the project workspace" onPress={() => router.push(`/project/${project.id}`)}
          subtitle={<>
            <Muted numberOfLines={1}>{shortPath(project.canonicalPath, 1)}</Muted>
            <Muted numberOfLines={2}>{project.summary.suggestedNextAction || "No next action recorded"}</Muted>
          </>}>
          {tags.length > 0 && <Inline style={styles.tags}>{tags.map((t) => <StatusMark key={t.label} spec={t} />)}</Inline>}
        </Row>;
      })}
    </Panel>)}
  </Screen>;
}

const styles = StyleSheet.create({
  toolbar: { gap: space.sm },
  tags: { marginTop: space.xxs },
});
