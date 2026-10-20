/** Port of src/ui/sections/Issues.tsx (Diagnostics): coverage strip and source read failures. */
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { ArrowRight, CircleAlert, CircleCheck, Clock, RefreshCw } from "lucide-react-native";
import { relative } from "../../../../src/ui/format.ts";
import { FRESHNESS, type StatusSpec } from "../../../../src/ui/status.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { usePortfolio } from "../../lib/portfolio";
import { Banner, Button, Disclosure, EmptyState, ErrorState, Inline, LoadingState, Muted, Panel, Row, Screen, Small } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { issueSources } from "../projects/model";

const SOURCE_ERROR: StatusSpec = { tone: "red", icon: CircleAlert, label: "Read failed" };
const WAITING: StatusSpec = { tone: "amber", icon: Clock, label: "Waiting outside the scan" };

export function IssuesScreen() {
  const api = useApi();
  const { data: portfolio, error, loading, refreshing, reload } = usePortfolio();
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  if (!portfolio) return loading || !error ? <Screen><LoadingState label="Loading diagnostics…" /></Screen>
    : <Screen><ErrorState message={error} onRetry={() => void reload()} /></Screen>;
  const { issues, coverage } = portfolio;
  const rescan = async () => {
    setRescanning(true); setRescanError(null);
    try { await api.post("/api/refresh"); await reload(); }
    catch (e) { setRescanError(describeError(e, "Refresh failed")); }
    finally { setRescanning(false); }
  };

  return <Screen refreshing={refreshing} onRefresh={() => void reload()}>
    {error && <Banner tone="red" title="Couldn't refresh" message={`${error} Showing the last loaded snapshot.`} />}
    {coverage && <View accessible accessibilityLabel={`Coverage: ${coverage.checked} checked, ${coverage.cached} cached, ${coverage.unavailable} unavailable${coverage.waitingOutsideCap ? `, ${coverage.waitingOutsideCap} waiting outside the scan` : ""}`}><Inline>
      <StatusMark spec={FRESHNESS.checked} strong>{`${coverage.checked} checked`}</StatusMark>
      <StatusMark spec={FRESHNESS.cached} strong>{`${coverage.cached} cached`}</StatusMark>
      <StatusMark spec={coverage.unavailable ? FRESHNESS.unavailable : { ...FRESHNESS.unavailable, tone: "gray" }} strong>{`${coverage.unavailable} unavailable`}</StatusMark>
      {!!coverage.waitingOutsideCap && <StatusMark spec={WAITING} strong>{`${coverage.waitingOutsideCap} waiting outside the scan`}</StatusMark>}
    </Inline></View>}
    <Muted>Source read failures, not failures in your code. Use Refresh to retry discovery.</Muted>
    <Button title="Refresh" icon={RefreshCw} loading={rescanning} onPress={() => void rescan()} />
    {rescanError && <Banner tone="red" title="Refresh failed" message={rescanError} />}
    {!issues.length && <Panel><EmptyState title="No source errors in the loaded snapshot" message="This does not prove unchecked projects are healthy." icon={CircleCheck} /></Panel>}
    {issueSources(issues).map((source) => { const list = issues.filter((i) => i.adapter === source); return <Panel key={source} title={source} spec={SOURCE_ERROR} count={list.length} padded={false}>
      {list.map((issue, index) => <Row key={index} title={issue.message} spec={SOURCE_ERROR} subtitle={`Observed ${relative(issue.observedAt)}`}>
        <Disclosure title="Source details">
          <Small selectable>Path: {issue.path ?? "Not available"}</Small>
          <Small selectable>Observed: {issue.observedAt}</Small>
        </Disclosure>
      </Row>)}
    </Panel>; })}
    {!issues.length && coverage && !coverage.unavailable && <StatusMark spec={{ tone: "green", icon: CircleCheck, label: "" }}>Every loaded source read cleanly.</StatusMark>}
    <Button title="Review waiting projects" icon={ArrowRight} onPress={() => router.push("/projects?waiting=1")} />
  </Screen>;
}
