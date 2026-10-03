import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { ArrowRight, Bot, ChevronLeft, CircleDashed, FileDiff, GitMerge, Info, MessageSquareReply, Play, RefreshCw, Square, UserCheck, X } from "lucide-react";
import { ACTIVE, type AgentRun, type RunEvent, type PacketSummary, type ReviewPacket } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { parseRoute, routeLink } from "../navigation.ts";
import { CountPill, StatusIcon, StatusMark, TrustLadder, type LadderStep } from "../components/Status.tsx";
import { CHECK_RESULT, RUN_STATUS, checkResult } from "../status.ts";
import { relative } from "../format.ts";

/** Plain words per status, derived from the one status language so they cannot drift. */
export const RUN_LABELS = Object.fromEntries(Object.entries(RUN_STATUS).map(([key, spec]) => [key, spec.label])) as Record<AgentRun["status"], string>;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Your draft is retained.";
/** Count beside a tab label. aria-hidden, so the tab's accessible name stays the plain word. */
const tabCount = (value: number) => value ? { rightSection: <CountPill value={value} /> } : {};

function EvidenceHistory({ id, history }: { id: string; history: PacketSummary[] }) {
  const [selected, setSelected] = useState(""), [packet, setPacket] = useState<ReviewPacket | null>(null), [error, setError] = useState("");
  useEffect(() => {
    setPacket(null); setError(""); if (!selected) return;
    const ac = new AbortController();
    void deliveryApi<ReviewPacket>(`/api/agents/runs/${id}/evidence/${selected}`, undefined, ac.signal).then(value => { if (!ac.signal.aborted) setPacket(value); }).catch(error => { if (!ac.signal.aborted) setError(errorText(error)); });
    return () => ac.abort();
  }, [id, selected]);
  if (!history.length) return null;
  return <details className="quiet-details"><summary>Retained evidence history ({history.length})</summary><Stack mt="sm" gap="sm">
    <Text size="sm" c="dimmed">Historical snapshots do not prove the current workspace still passes.</Text>
    <NativeSelect label="Previous review packet" value={selected} onChange={e => setSelected(e.currentTarget.value)} data={[{ value: "", label: "Choose a recorded snapshot" }, ...history.map(h => ({ value: String(h.id), label: `Turn ${h.turn}, ${new Date(h.createdAt).toLocaleString()}` }))]} />
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {selected && !packet && !error && <Text role="status">Loading recorded evidence…</Text>}
    {packet && <>
      <ul className="result-list" aria-label="Snapshot checks">{packet.checks.length ? packet.checks.map((check, index) => { const spec = CHECK_RESULT[checkResult(check.exitCode)]; return <li key={index} className="result-row"><StatusIcon spec={spec} /><span className="result-row-title">{check.label}</span><span className="result-row-detail">{spec.label}{check.exitCode !== null ? ` · exit ${check.exitCode}` : ""}</span></li>; }) : <li className="result-row"><StatusIcon spec={CHECK_RESULT["not-run"]} /><span className="result-row-title">No checks in this snapshot</span></li>}</ul>
      <details className="quiet-details"><summary>Raw packet (JSON)</summary><pre className="agent-output" role="region" tabIndex={0} aria-label="Historical evidence">{JSON.stringify(packet, null, 2)}</pre></details>
    </>}
  </Stack></details>;
}

/** Reported, checked, accepted, shipped: four separate facts, never one green blob. */
function ladderFor(run: AgentRun): LadderStep[] {
  const configured = run.checks.length;
  const results = run.packet?.checks ?? [];
  const passing = results.filter(check => check.exitCode === 0).length;
  const failing = results.some(check => check.exitCode !== 0);
  const reported = !!run.packet || ["review", "checking", "accepted"].includes(run.status);
  const checks: LadderStep = !configured
    ? { spec: { tone: "gray", icon: CircleDashed, label: "" }, title: "No automated checks", detail: "Manual review only", state: "todo" }
    : failing ? { spec: CHECK_RESULT.failed, title: "Checks failed", detail: `${passing} of ${configured} passing`, state: "current" }
    : results.length === configured ? { spec: CHECK_RESULT.passed, title: "Checks passed", detail: `${passing} of ${configured} on this revision`, state: "done" }
    : { spec: CHECK_RESULT["not-run"], title: "Checks not run", detail: `${passing} of ${configured} on this revision`, state: run.status === "review" ? "current" : "todo" };
  const reviewing = run.status === "review";
  return [
    reported
      ? { spec: { tone: "gray", icon: Bot, label: "" }, title: "Agent finished", detail: "Reported, not verified", state: "done" }
      : ACTIVE.includes(run.status) || run.status === "queued"
        ? { spec: { tone: "blue", icon: Bot, label: "" }, title: "Agent working", detail: "Nothing to review yet", state: "current" }
        : { spec: { tone: "gray", icon: Bot, label: "" }, title: "Agent did not finish", detail: "No result to review", state: "todo" },
    checks,
    run.status === "accepted"
      ? { spec: { tone: "green", icon: UserCheck, label: "" }, title: "You accepted", detail: "Recorded decision", state: "done" }
      : { spec: { tone: reviewing ? "amber" : "gray", icon: UserCheck, label: "" }, title: "You accept", detail: reviewing ? "Waiting for you" : "Not yet", state: reviewing ? "current" : "todo" },
    { spec: { tone: "gray", icon: GitMerge, label: "" }, title: "Merge or deploy", detail: "Separate. Accepting does not do this", state: "separate" },
  ];
}

export function AgentRunWorkspace({ id, polling, refresh, onSaved, returnTo }: { id: string; polling: boolean; refresh: number; onSaved: () => void; returnTo: string | null }) {
  const [run, setRun] = useState<AgentRun | null>(null), [events, setEvents] = useState<RunEvent[]>([]), [error, setError] = useState("");
  const [message, setMessage] = useState(""), [confirmed, setConfirmed] = useState<string[]>([]), [stopped, setStopped] = useState(false), [manual, setManual] = useState(false), [busy, setBusy] = useState(false);
  const cursor = useRef(0), lock = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [connectionError, setConnectionError] = useState(""), [history, setHistory] = useState<PacketSummary[]>([]);
  useDraftGuard(!!message, hash => parseRoute(hash).runId === id);
  const runFilter = parseRoute(location.hash).runFilter;
  const listHref = routeLink("agents", { filter: runFilter === "all" ? null : runFilter, return: returnTo });
  const restoreListFocus = () => requestAnimationFrame(() => document.getElementById(`agent-row-${id}`)?.focus());
  useEffect(() => { heading.current?.focus(); }, [run?.id]);
  useEffect(() => {
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        if (document.visibilityState !== "visible") return;
        const value = await deliveryApi<{ run: AgentRun; events: RunEvent[]; history: PacketSummary[] }>(`/api/agents/runs/${id}?after=${cursor.current}`, undefined, ac.signal);
        if (!ac.signal.aborted) { setRun(value.run); setHistory(value.history); setConnectionError(""); if (value.events.length) { cursor.current = value.events.at(-1)!.seq; setEvents(old => [...old, ...value.events].slice(-500)); } }
      } catch(error) { if (!ac.signal.aborted) setConnectionError(errorText(error)); }
      finally { if (!ac.signal.aborted && polling) timer = setTimeout(load, 2000); }
    }
    void load(); return () => { ac.abort(); clearTimeout(timer); };
  }, [id, polling, refresh]);
  useEffect(() => { setConfirmed([]); setManual(false); }, [run?.packet?.fingerprint, run?.turn]);
  async function action(action: string, extra: object = {}) {
    if (!run || lock.current) return; lock.current = true; setBusy(true); setError("");
    try { const value = await deliveryApi<AgentRun>(`/api/agents/runs/${id}/actions`, { action, revision: run.revision, message, reason: message, fingerprint: run.packet?.fingerprint, confirmCriteria: confirmed.length === run.criteria.length, acknowledgeNoChecks: manual, confirmStopped: stopped, ...extra }); setRun(value); onSaved(); if (["reply", "retry", "accept", "dismiss"].includes(action)) setMessage(""); }
    catch(error) { setError(errorText(error)); } finally { setBusy(false); lock.current = false; }
  }
  const back = <Group gap="xs"><Button component="a" href={listHref} variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} onClick={restoreListFocus}>All runs</Button>{returnTo && <Button component="a" href={returnTo} variant="subtle" color="dark">Return to inbox context</Button>}</Group>;
  if (!run) return <Stack>{back}{connectionError ? <Alert color="red" role="alert">{connectionError}</Alert> : <Text role="status">Loading run…</Text>}</Stack>;
  const spec = RUN_STATUS[run.status];
  const passing = run.packet?.checks.filter(check => check.exitCode === 0).length ?? 0;
  const acceptBlocked = busy || !message.trim() || !run.packet || confirmed.length !== run.criteria.length || (run.checks.length ? run.packet?.checks.length !== run.checks.length || run.packet.checks.some(check => check.exitCode !== 0) : !manual);
  const canAct = ["review", "failed", "stopped", "interrupted"].includes(run.status);
  return <Stack gap="md">
    {back}
    {connectionError && <Alert title="Run updates unavailable" color="red" role="alert">{connectionError} Last loaded state may be stale.</Alert>}
    {error && <Alert title="Action unavailable" color="red" role="alert">{error}</Alert>}
    <header className="run-header">
      <Title order={3} ref={heading} tabIndex={-1}>{run.title}</Title>
      <div className="status-line"><span>{run.projectName}</span><StatusMark spec={spec} strong /><span>Updated {relative(run.updatedAt)}</span></div>
      {run.reason && <Text size="sm">{run.reason}</Text>}
    </header>
    <TrustLadder steps={ladderFor(run)} />
    {(run.handoffId || ACTIVE.includes(run.status) || run.status === "queued") && <Group gap="xs">
      {run.handoffId && <Button component="a" href={`#queue?delivery=${encodeURIComponent(run.projectId)}`} variant="subtle" color="dark" rightSection={<ArrowRight size={16} aria-hidden="true" />}>Open linked delivery and milestone review</Button>}
      {(ACTIVE.includes(run.status) || run.status === "queued") && <Button color="red" variant="subtle" leftSection={<Square size={16} aria-hidden="true" />} loading={busy} onClick={() => void action("stop")}>Stop run (keep workspace)</Button>}
    </Group>}
    {run.permission && <section className="permission-card" aria-label="Permission request">
      <StatusMark spec={RUN_STATUS.waiting} strong>Agent needs your permission</StatusMark>
      <Text className="permission-title">{run.permission.title}</Text>
      <Group gap="xs">{run.permission.options.map((option, index) => <Button key={option.optionId} variant={index === 0 ? "filled" : "default"} disabled={busy} onClick={() => void action("permission", { optionId: option.optionId })}>{option.name}</Button>)}<Button variant="subtle" color="red" leftSection={<X size={16} aria-hidden="true" />} disabled={busy} onClick={() => void action("permission", { optionId: null })}>Deny request</Button></Group>
    </section>}
    <Tabs defaultValue={run.status === "review" ? "changes" : "activity"} keepMounted className="run-tabs">
      <Tabs.List aria-label="Run evidence"><Tabs.Tab value="activity">Activity</Tabs.Tab><Tabs.Tab value="changes" {...tabCount(run.packet?.files.length ?? 0)}>Changes</Tabs.Tab><Tabs.Tab value="checks" {...tabCount(run.checks.length)}>Checks</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="activity" pt="md"><Text size="sm" c="dimmed" mb="xs">Latest 500 events; output is capped and common credential patterns are redacted. Agent text is not verified evidence.</Text><pre className="agent-output" role="region" tabIndex={0} aria-label="Agent activity">{events.map(event => event.kind === "output" ? event.text : `\n[${event.kind}] ${event.text}\n`).join("") || "No activity yet."}</pre></Tabs.Panel>
      <Tabs.Panel value="changes" pt="md">{run.packet ? <Stack gap="sm">
        <p className="section-label">Changed files · captured {relative(run.packet.capturedAt)}</p>
        <ul className="result-list" aria-label="Changed files">{run.packet.files.length ? run.packet.files.map(file => <li key={file} className="result-row"><StatusIcon spec={{ tone: "blue", icon: FileDiff, label: "" }} /><span className="result-row-title">{file}</span></li>) : <li className="result-row"><StatusIcon spec={CHECK_RESULT["not-run"]} /><span className="result-row-title">No file changes</span></li>}</ul>
        <pre className="agent-output" role="region" tabIndex={0} aria-label="Workspace diff">{run.packet.diff || "No file changes."}</pre>
      </Stack> : <Text>No evidence packet captured yet.</Text>}</Tabs.Panel>
      <Tabs.Panel value="checks" pt="md"><Stack gap="sm">{run.packet ? <>
        <p className="section-label">Checks for revision {run.packet.fingerprint.slice(0, 12)}</p>
        <ul className="result-list" aria-label="Check results">
          {run.packet.checks.map((check, index) => { const result = CHECK_RESULT[checkResult(check.exitCode)]; return <li key={`${index}:${check.label}`} className="result-row"><StatusIcon spec={result} /><span className="result-row-title">{check.label}: {check.exitCode === 0 ? "passed" : `failed (${check.exitCode ?? "interrupted"})`}</span><details><summary>Output</summary><pre className="agent-output" role="region" aria-label={`${check.label} output`} tabIndex={0}>{check.output || "No output."}</pre></details></li>; })}
          {run.checks.filter(configured => !run.packet!.checks.some(done => done.label === configured.label)).map(pending => <li key={pending.label} className="result-row"><StatusIcon spec={CHECK_RESULT["not-run"]} /><span className="result-row-title">{pending.label}</span><span className="result-row-detail">Not run on this revision</span></li>)}
        </ul>
        {!run.checks.length && <Text size="sm" c="dimmed">No automated checks are configured for this assignment.</Text>}
      </> : <Text>No check evidence yet.</Text>}</Stack></Tabs.Panel>
    </Tabs>
    {run.status === "review" && <Group gap="xs"><Button variant="default" leftSection={<Play size={16} aria-hidden="true" />} disabled={busy || !run.packet || !run.checks.length} onClick={() => void action("check")}>Run approved checks</Button><Button variant="subtle" color="dark" leftSection={<RefreshCw size={16} aria-hidden="true" />} disabled={busy} onClick={() => void action("refresh")}>Refresh evidence (invalidates previous checks)</Button></Group>}
    {canAct && <section aria-label="Run review actions" className="action-bar"><Stack gap="sm">
      {run.status === "review" && <div className="check-gate">
        <Text fw={600}>Review packet</Text>
        <StatusMark spec={!run.packet ? CHECK_RESULT["not-run"] : run.checks.length && passing === run.checks.length ? CHECK_RESULT.passed : run.packet.checks.some(check => check.exitCode !== 0) ? CHECK_RESULT.failed : CHECK_RESULT["not-run"]}>{run.packet ? `${passing} passing / ${run.checks.length} configured checks` : "Evidence is unavailable"}</StatusMark>
        {run.packet && <>{!run.checks.length && <Checkbox label="No automated checks are configured; I performed and describe the manual verification below" checked={manual} onChange={e => setManual(e.currentTarget.checked)} />}{run.criteria.map((criterion, index) => <Checkbox key={index} label={`I verified: ${criterion}`} checked={confirmed.includes(String(index))} onChange={e => setConfirmed(e.currentTarget.checked ? [...confirmed, String(index)] : confirmed.filter(value => value !== String(index)))} />)}</>}
      </div>}
      <Textarea label="Reply, requested changes, or acceptance evidence" description="Feedback resumes the same conversation and workspace." value={message} maxLength={16000} onChange={e => setMessage(e.currentTarget.value)} autosize minRows={3} />
      {run.status === "interrupted" && <Checkbox label="I confirmed no previous agent is still working in this workspace" checked={stopped} onChange={e => setStopped(e.currentTarget.checked)} />}
      {run.status === "review" && <p className="action-note"><Info size={14} aria-hidden="true" />Accepting records your decision. It does not commit, merge or deploy anything.</p>}
      <div className="action-bar-buttons">
        <Button variant="subtle" color="red" disabled={busy || !message.trim()} onClick={() => void action("dismiss")}>Close without accepting</Button>
        <Button variant="default" leftSection={<MessageSquareReply size={16} aria-hidden="true" />} disabled={busy || !message.trim() || (run.status === "interrupted" && !stopped)} onClick={() => void action(run.status === "review" ? "reply" : "retry")}>{run.status === "review" ? "Reply / request changes" : "Retry with this instruction"}</Button>
        {run.status === "review" && <Button className="action-primary" leftSection={<UserCheck size={16} aria-hidden="true" />} disabled={acceptBlocked} onClick={() => void action("accept")}>Accept reviewed work</Button>}
      </div>
    </Stack></section>}
    <details className="quiet-details"><summary>Workspace and session diagnostics</summary><Text size="sm">Turn {run.turn} · {run.sessionId ? `Session ${run.sessionId}` : "Session not started"}</Text>{run.workspace && <Text size="sm">Workspace: {run.workspace}<br />Branch: {run.branch}</Text>}</details>
    <EvidenceHistory id={id} history={history} />
  </Stack>;
}
