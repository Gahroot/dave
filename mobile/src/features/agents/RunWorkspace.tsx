/** One run: activity, changes, checks, review gate and actions (web AgentRunWorkspace). */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { ArrowRight, FileDiff, Info, MessageSquareReply, Play, RefreshCw, Square, UserCheck, X } from "lucide-react-native";
import type { AgentRun, PacketSummary, ReviewPacket, RunEvent } from "../../../../src/agents/types.ts";
import { CHECK_RESULT, RUN_STATUS, checkResult, type StatusSpec } from "../../../../src/ui/status.ts";
import { relative } from "../../../../src/ui/format.ts";
import { ApiError, describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import {
  Banner, BottomSpacer, Body, Button, Caption, Code, Disclosure, ErrorState, Heading, Inline, KeyValue, LoadingState, Muted, Panel, Row, Screen, Segmented, SelectField, Small, Stack, TextField, Toggle, confirm, tick,
} from "../../ui/primitives";
import { StatusMark, TrustLadder } from "../../ui/status";
import { colors, space } from "../../ui/theme";
import { Checkbox, ladderFor, useDraftGuard } from "./components";
import { acceptBlocked, activityText, appendEvents, canAct, clearsDraft, passingCount, pendingChecks, reviewMark, stoppable } from "./model";

type RunResponse = { run: AgentRun; events: RunEvent[]; history: PacketSummary[] };
type Tab = "activity" | "changes" | "checks";
const FILE: StatusSpec = { tone: "blue", icon: FileDiff, label: "Changed file" };

/** Cursor polling exactly like the web: GET ?after=<last seq>, next poll 2 s after the previous finishes. */
function useRunPolling(id: string, live: boolean) {
  const api = useApi();
  const [run, setRun] = useState<AgentRun | null>(null), [events, setEvents] = useState<RunEvent[]>([]), [history, setHistory] = useState<PacketSummary[]>([]);
  const [connectionError, setConnectionError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const cursor = useRef(0), inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return; inFlight.current = true;
    try {
      const value = await api.get<RunResponse>(`/api/agents/runs/${id}?after=${cursor.current}`);
      setRun(value.run); setHistory(value.history); setConnectionError("");
      const next = appendEvents([], value.events);
      if (next.cursor !== null) { cursor.current = next.cursor; setEvents((old) => appendEvents(old, value.events).events); }
    } catch (e) { setConnectionError(describeError(e, "Request failed.")); } finally { inFlight.current = false; }
  }, [api, id]);
  useEffect(() => { cursor.current = 0; setRun(null); setEvents([]); setHistory([]); setConnectionError(""); }, [id]);
  useFocusEffect(useCallback(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tickLoad = async () => {
      if (AppState.currentState === "active") await load();
      if (!stopped && live) timer = setTimeout(() => void tickLoad(), 2000);
    };
    void tickLoad();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void load(); });
    return () => { stopped = true; if (timer) clearTimeout(timer); sub.remove(); };
  }, [load, live]));
  const refresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);
  return { run, setRun, events, history, connectionError, refresh, refreshing };
}

export function RunWorkspace({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const navigation = useNavigation();
  const [live, setLive] = useState(true);
  const { run, setRun, events, history, connectionError, refresh, refreshing } = useRunPolling(id, live);
  const [message, setMessage] = useState(""), [confirmed, setConfirmed] = useState<number[]>([]), [stopped, setStopped] = useState(false), [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [tab, setTab] = useState<Tab | null>(null);
  const lock = useRef(false);
  useDraftGuard(!!message);
  useEffect(() => { setConfirmed([]); setManual(false); }, [run?.packet?.fingerprint, run?.turn]);
  useEffect(() => { if (run) navigation.setOptions({ title: run.title }); }, [navigation, run?.title, run]);

  async function action(name: string, extra: object = {}) {
    if (!run || lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      const value = await api.post<AgentRun>(`/api/agents/runs/${id}/actions`, {
        action: name, revision: run.revision, message, reason: message, fingerprint: run.packet?.fingerprint,
        confirmCriteria: confirmed.length === run.criteria.length, acknowledgeNoChecks: manual, confirmStopped: stopped, ...extra,
      });
      setRun(value); tick(); if (clearsDraft(name)) setMessage("");
    } catch (e) {
      setError(describeError(e, "Request failed. Your draft is retained."));
      if (e instanceof ApiError && e.status === 409) void refresh();
    } finally { setBusy(false); lock.current = false; }
  }

  if (!run) return <Screen onRefresh={() => void refresh()} refreshing={refreshing}>
    {connectionError ? <ErrorState message={connectionError} onRetry={() => void refresh()} /> : <LoadingState label="Loading run…" />}
  </Screen>;

  const spec = RUN_STATUS[run.status];
  const passing = passingCount(run);
  const blocked = acceptBlocked(run, { busy, message, confirmed: confirmed.length, manual });
  const current: Tab = tab ?? (run.status === "review" ? "changes" : "activity");
  const mark = reviewMark(run);
  const packet = run.packet;

  return <Screen onRefresh={() => void refresh()} refreshing={refreshing}>
    {connectionError && <Banner tone="red" title="Run updates unavailable" message={`${connectionError} Last loaded state may be stale.`} />}
    {error && <Banner tone="red" title="Action unavailable" message={error} />}

    <Panel>
      <Heading>{run.title}</Heading>
      <StatusMark spec={spec} strong />
      <Muted>{`${run.projectName} · Updated ${relative(run.updatedAt)}`}</Muted>
      {!!run.reason && <Small selectable>{run.reason}</Small>}
      <TrustLadder steps={ladderFor(run)} />
      {run.handoffId && <Button variant="subtle" icon={ArrowRight} title="Open linked delivery and milestone review" onPress={() => router.push(`/delivery/${encodeURIComponent(run.projectId)}`)} />}
      {stoppable(run) && <Button variant="danger-subtle" icon={Square} title="Stop run (keep workspace)" loading={busy}
        onPress={() => { void confirm({ title: "Stop this run?", message: "The agent stops; the workspace is kept.", confirmLabel: "Stop run", destructive: true }).then((ok) => { if (ok) void action("stop"); }); }} />}
      <Toggle label="Live updates" value={live} onValueChange={setLive} />
    </Panel>

    {run.permission && <Panel title="Agent needs your permission" spec={RUN_STATUS.waiting} tone="amber">
      <Body selectable>{run.permission.title}</Body>
      {run.permission.options.map((option, index) => <Button key={option.optionId} variant={index === 0 ? "primary" : "secondary"} title={option.name} disabled={busy}
        onPress={() => void action("permission", { optionId: option.optionId })} />)}
      <Button variant="danger-subtle" icon={X} title="Deny request" disabled={busy} onPress={() => void action("permission", { optionId: null })} />
    </Panel>}

    <Panel title="Run evidence">
      <Segmented label="Run evidence" value={current} onChange={setTab} options={[
        { value: "activity", label: "Activity" },
        { value: "changes", label: "Changes", count: packet?.files.length ?? 0 },
        { value: "checks", label: "Checks", count: run.checks.length },
      ]} />
      {current === "activity" && <>
        <Caption>Latest 500 events; output is capped and common credential patterns are redacted. Agent text is not verified evidence.</Caption>
        <Code>{activityText(events)}</Code>
      </>}
      {current === "changes" && (packet ? <>
        <Caption>{`Changed files · captured ${relative(packet.capturedAt)}`}</Caption>
        {packet.files.length ? packet.files.map((file) => <Row key={file} title={file} spec={FILE} />) : <Row title="No file changes" spec={CHECK_RESULT["not-run"]} />}
        <Code>{packet.diff || "No file changes."}</Code>
      </> : <Body>No evidence packet captured yet.</Body>)}
      {current === "checks" && (packet ? <>
        <Caption>{`Checks for revision ${packet.fingerprint.slice(0, 12)}`}</Caption>
        {packet.checks.map((check, index) => <Stack key={`${index}:${check.label}`} gap={space.xs}>
          <Row title={`${check.label}: ${check.exitCode === 0 ? "passed" : `failed (${check.exitCode ?? "interrupted"})`}`} spec={CHECK_RESULT[checkResult(check.exitCode)]} />
          <Disclosure title="Output"><Code>{check.output || "No output."}</Code></Disclosure>
        </Stack>)}
        {pendingChecks(run).map((pending) => <Row key={pending.label} title={pending.label} subtitle="Not run on this revision" spec={CHECK_RESULT["not-run"]} />)}
        {!run.checks.length && <Muted>No automated checks are configured for this assignment.</Muted>}
      </> : <Body>No check evidence yet.</Body>)}
      {run.status === "review" && <Inline>
        <Button icon={Play} title="Run approved checks" disabled={busy || !packet || !run.checks.length} onPress={() => void action("check")} />
        <Button variant="subtle" icon={RefreshCw} title="Refresh evidence (invalidates previous checks)" disabled={busy} onPress={() => void action("refresh")} />
      </Inline>}
    </Panel>

    {canAct(run) && <Panel title="Run review actions">
      {run.status === "review" && <Stack gap={space.sm}>
        <Body strong>Review packet</Body>
        <StatusMark spec={CHECK_RESULT[mark]}>{packet ? `${passing} passing / ${run.checks.length} configured checks` : "Evidence is unavailable"}</StatusMark>
        {packet && <>
          {!run.checks.length && <Checkbox label="No automated checks are configured; I performed and describe the manual verification below" checked={manual} onChange={setManual} />}
          {run.criteria.map((criterion, index) => <Checkbox key={index} label={`I verified: ${criterion}`} checked={confirmed.includes(index)}
            onChange={(on) => setConfirmed(on ? [...confirmed, index] : confirmed.filter((v) => v !== index))} />)}
        </>}
      </Stack>}
      <TextField label="Reply, requested changes, or acceptance evidence" help="Feedback resumes the same conversation and workspace." multiline maxLength={16000} value={message} onChangeText={setMessage} />
      {run.status === "interrupted" && <Checkbox label="I confirmed no previous agent is still working in this workspace" checked={stopped} onChange={setStopped} />}
      {run.status === "review" && <Inline wrap={false}><Info size={14} color={colors.muted} /><View style={{ flex: 1 }}><Small>Accepting records your decision. It does not commit, merge or deploy anything.</Small></View></Inline>}
      {run.status === "review" && <Button variant="primary" icon={UserCheck} title="Accept reviewed work" disabled={blocked} loading={busy} onPress={() => void action("accept")} />}
      <Button icon={MessageSquareReply} title={run.status === "review" ? "Reply / request changes" : "Retry with this instruction"}
        disabled={busy || !message.trim() || (run.status === "interrupted" && !stopped)} onPress={() => void action(run.status === "review" ? "reply" : "retry")} />
      <Button variant="danger-subtle" title="Close without accepting" disabled={busy || !message.trim()}
        onPress={() => { void confirm({ title: "Close without accepting?", message: "The run is closed and your message is recorded as the reason.", confirmLabel: "Close run", destructive: true }).then((ok) => { if (ok) void action("dismiss"); }); }} />
    </Panel>}

    <Panel>
      <Disclosure title="Workspace and session diagnostics">
        <KeyValue label="Turn">{String(run.turn)}</KeyValue>
        <KeyValue label="Session">{run.sessionId ? `Session ${run.sessionId}` : "Session not started"}</KeyValue>
        {run.workspace && <KeyValue label="Workspace">{run.workspace}</KeyValue>}
        {run.workspace && <KeyValue label="Branch">{run.branch}</KeyValue>}
      </Disclosure>
      <EvidenceHistory id={id} history={history} />
    </Panel>
    <BottomSpacer />
  </Screen>;
}


function EvidenceHistory({ id, history }: { id: string; history: PacketSummary[] }) {
  const api = useApi();
  const [selected, setSelected] = useState<string | null>(null), [packet, setPacket] = useState<ReviewPacket | null>(null), [error, setError] = useState("");
  useEffect(() => {
    setPacket(null); setError(""); if (!selected) return;
    let live = true;
    api.get<ReviewPacket>(`/api/agents/runs/${id}/evidence/${selected}`)
      .then((value) => { if (live) setPacket(value); })
      .catch((e: unknown) => { if (live) setError(describeError(e, "Request failed.")); });
    return () => { live = false; };
  }, [api, id, selected]);
  if (!history.length) return null;
  return <Disclosure title="Retained evidence history" count={history.length}>
    <Muted>Historical snapshots do not prove the current workspace still passes.</Muted>
    <SelectField label="Previous review packet" placeholder="Choose a recorded snapshot" value={selected} onChange={setSelected}
      options={history.map((h) => ({ value: String(h.id), label: `Turn ${h.turn}, ${new Date(h.createdAt).toLocaleString()}` }))} />
    {error && <Banner tone="red" title="Evidence unavailable" message={error} />}
    {selected && !packet && !error && <LoadingState label="Loading recorded evidence…" />}
    {packet && <>
      {packet.checks.length ? packet.checks.map((check, index) => {
        const s = CHECK_RESULT[checkResult(check.exitCode)];
        return <Row key={index} title={check.label} subtitle={`${s.label}${check.exitCode !== null ? ` · exit ${check.exitCode}` : ""}`} spec={s} />;
      }) : <Row title="No checks in this snapshot" spec={CHECK_RESULT["not-run"]} />}
      <Disclosure title="Raw packet (JSON)"><Code>{JSON.stringify(packet, null, 2)}</Code></Disclosure>
    </>}
  </Disclosure>;
}
