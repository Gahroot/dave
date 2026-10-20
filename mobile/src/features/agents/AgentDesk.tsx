/** Agent desk: summary, runs list with filters (web AgentPlatform, runs view). */
import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Plus, RefreshCw, Settings } from "lucide-react-native";
import type { AgentOverview } from "../../../../src/agents/types.ts";
import { RUN_STATUS } from "../../../../src/ui/status.ts";
import { relative } from "../../../../src/ui/format.ts";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Caption, Divider, EmptyState, Inline, LoadingState, Panel, Row, Screen, Segmented, Stack, Toggle } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { space } from "../../ui/theme";
import { EXECUTION } from "./components";
import { FILTERS, countRuns, executionState, inFilter, runFilter, runReason, type RunFilter } from "./model";

export function AgentDesk() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const router = useRouter();
  const [filter, setFilter] = useState<RunFilter>(runFilter(params.filter));
  const [live, setLive] = useState(true);
  const { data, error, loading, refreshing, reload } = useResource<AgentOverview>("/api/agents", { pollMs: live ? 2500 : undefined });
  const runs = data?.runs.filter((run) => inFilter(run, filter)) ?? [];
  const count = (f: RunFilter) => data ? countRuns(data.runs, f) : 0;
  const attention = count("attention"), active = count("active"), queued = count("queued");
  const execution = data ? EXECUTION[executionState(data.settings)] : null;

  return <Screen refreshing={refreshing} onRefresh={() => void reload()}>
    <Panel title="Agent desk" note={data ? `Runner: ${data.runner}` : undefined}>
      <Button variant="primary" icon={Plus} title="New assignment" onPress={() => router.push("/agents/new")} />
      <Button variant="subtle" icon={Settings} title="Execution settings" onPress={() => router.push("/agents/settings")} />
      {data && <Stack gap={space.xs}>
        <StatusMark spec={attention ? RUN_STATUS.review : { ...RUN_STATUS.review, tone: "gray" }} strong>{`${attention} need attention`}</StatusMark>
        <StatusMark spec={active ? RUN_STATUS.running : { ...RUN_STATUS.running, tone: "gray", spin: false }}>{`${active} active`}</StatusMark>
        <StatusMark spec={RUN_STATUS.queued}>{`${queued} queued`}</StatusMark>
        {execution && <Row title={execution.label} spec={execution} onPress={() => router.push("/agents/settings")} accessibilityHint="Opens execution settings" />}
      </Stack>}
      <Divider />
      <Toggle label="Live updates" value={live} onValueChange={setLive} />
      <Inline><Button compact variant="subtle" icon={RefreshCw} title="Refresh runs" onPress={() => void reload()} /></Inline>
    </Panel>
    {error && <Banner tone="red" title="Connection unavailable" message={`${error} Last loaded state may be out of date.`} />}
    {loading && !data && !error && <LoadingState label="Loading runs…" />}
    {data && <Panel title="Runs" padded={false}>
      <Stack gap={0} style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}>
        <Segmented label="Run filters" value={filter} onChange={setFilter}
          options={FILTERS.map(([value, label]) => ({ value, label, count: count(value), tone: value === "attention" ? "amber" as const : undefined }))} />
      </Stack>
      {runs.map((run, i) => {
        const spec = RUN_STATUS[run.status];
        const reason = runReason(run);
        return <Stack key={run.id} gap={0}>
          {i > 0 && <Divider />}
          <Row title={run.title} spec={spec} onPress={() => router.push(`/agents/${run.id}`)}
            accessibilityLabel={`${run.title}, ${spec.label}, ${run.projectName}`}
            subtitle={<Stack gap={space.xxs}>
              <Inline><Caption>{`${run.projectName} · ${relative(run.updatedAt)}`}</Caption><StatusMark spec={spec} /></Inline>
              {!!reason && <Caption>{reason}</Caption>}
            </Stack>} />
        </Stack>;
      })}
      {!runs.length && <Stack style={{ paddingHorizontal: space.lg }}>
        <EmptyState title={data.runs.length ? "No runs match this filter" : "No agent runs yet"} message="Start with one bounded assignment. Execution requires explicit authorization." />
      </Stack>}
      {data.runs.length === 200 && <Stack style={{ padding: space.lg }}><Caption>Showing the latest 200 loaded runs, with unresolved work first.</Caption></Stack>}
    </Panel>}
  </Screen>;
}
