import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NumberInput, Stack, Text } from "@mantine/core";
import { ChevronLeft, Lock, LockOpen, Plus, RefreshCw, Settings, TriangleAlert } from "lucide-react";
import { ACTIVE, ATTENTION, type AgentOverview, type AgentRun, type AgentSettings } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { AgentAssignment } from "./AgentAssignment.tsx";
import { AgentRunWorkspace } from "./AgentRunWorkspace.tsx";
import { parseRoute, routeLink, type RunFilter } from "../navigation.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
import { CountPill, StatusIcon, StatusMark } from "../components/Status.tsx";
import { RUN_STATUS, hasRail, type StatusSpec } from "../status.ts";
import { relative } from "../format.ts";

const inFilter = (run: AgentRun, filter: RunFilter): boolean => filter === "all" || filter === "attention" && ATTENTION.includes(run.status) || filter === "active" && ACTIVE.includes(run.status) || filter === "queued" && run.status === "queued" || filter === "finished" && ["accepted", "stopped"].includes(run.status);
const FILTERS = [["all", "All"], ["attention", "Needs attention"], ["active", "Active"], ["queued", "Queued"], ["finished", "Finished"]] as const;
const EXECUTION: Readonly<Record<"enabled" | "paused" | "disabled", StatusSpec>> = {
  enabled: { tone: "green", icon: LockOpen, label: "Execution enabled" },
  paused: { tone: "amber", icon: Lock, label: "Execution paused" },
  disabled: { tone: "gray", icon: Lock, label: "Execution disabled" },
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Your draft is retained.";

export function AgentPlatform({ paused = false }: { paused?: boolean }) {
  const [data, setData] = useState<AgentOverview | null>(null), [error, setError] = useState("");
  const [route, setRoute] = useState(location.hash), [polling, setPolling] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const live = polling && !paused;
  useEffect(() => { const update = () => setRoute(location.hash); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { if (document.visibilityState !== "visible") return; const value = await deliveryApi<AgentOverview>("/api/agents", undefined, controller.signal); if (!controller.signal.aborted) { setData(value); setError(""); } }
      catch(error) { if (!controller.signal.aborted) setError(errorText(error)); }
      finally { if (!controller.signal.aborted && live) timer = setTimeout(load, 2500); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh, live]);
  const navigation = parseRoute(route);
  const composer = navigation.view === "new" || !!navigation.handoff || !!navigation.meetingItem;
  const runs = data?.runs.filter(run => inFilter(run, navigation.runFilter)) ?? [];
  const count = (filter: RunFilter) => data?.runs.filter(run => inFilter(run, filter)).length ?? 0;
  const execution = !data ? null : EXECUTION[data.settings.enabled ? data.settings.paused ? "paused" : "enabled" : "disabled"];
  const attention = count("attention"), active = count("active"), queued = count("queued");
  return <Stack gap="md" className="agent-desk" data-run-selected={!!navigation.runId}>
    <PageHeader title="Agent desk" actions={<Group className="desk-actions" gap="xs"><Button component="a" href="#agents?view=new" leftSection={<Plus size={16} aria-hidden="true" />}>New assignment</Button><Button component="a" href="#agents?view=settings" variant="subtle" color="dark" leftSection={<Settings size={16} aria-hidden="true" />}>Execution settings</Button></Group>} />
    <div className="count-strip desk-summary" role="group" aria-label="Agent desk summary">
      {data && <>
        <StatusMark spec={attention ? RUN_STATUS.review : { ...RUN_STATUS.review, tone: "gray" }}><strong>{attention}</strong> need attention</StatusMark>
        <StatusMark spec={active ? RUN_STATUS.running : { ...RUN_STATUS.running, tone: "gray", spin: false }}><strong>{active}</strong> active</StatusMark>
        <StatusMark spec={RUN_STATUS.queued}><strong>{queued}</strong> queued</StatusMark>
        {execution && <a className="execution-link" href="#agents?view=settings"><StatusMark spec={execution} /></a>}
      </>}
      <span className="count-strip-end desk-live"><Checkbox size="sm" label="Live updates" disabled={paused} checked={live} onChange={e => setPolling(e.currentTarget.checked)} /><Button variant="subtle" color="dark" size="xs" leftSection={<RefreshCw size={14} aria-hidden="true" />} onClick={() => setRefresh(value => value + 1)}>Refresh runs</Button></span>
    </div>
    {error && <Alert title="Connection unavailable" color="red" role="alert">{error} Last loaded state may be out of date.</Alert>}
    {!data && !error && <Text role="status">Loading runs…</Text>}
    {data && <>
      {navigation.view === "settings" ? <><Button component="a" href="#agents" variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />}>All runs</Button><RuntimeSettings initial={data.settings} onSaved={() => setRefresh(value => value + 1)} /></> : composer ? <AgentAssignment key={`${navigation.project}:${navigation.handoff}:${navigation.meetingItem}`} data={data} projectId={navigation.project ?? ""} handoffId={navigation.handoff} meetingItemId={navigation.meetingItem} /> : <>
        <nav className="workspace-filter" aria-label="Run filters">{FILTERS.map(([filter, label]) => <a key={filter} href={routeLink("agents", { filter, return: navigation.returnTo }, navigation.runId)} aria-current={navigation.runFilter === filter ? "true" : undefined}>{label}{!!count(filter) && <CountPill value={count(filter)} tone={filter === "attention" ? "amber" : undefined} />}</a>)}</nav>
        <div className={`workspace-split${navigation.runId || navigation.invalidRun ? " has-selection" : ""}`}>
          <div className="workspace-list" aria-label="Agent runs">{runs.map(run => {
            const spec = RUN_STATUS[run.status];
            return <a key={run.id} id={`agent-row-${run.id}`} className="workspace-row" data-tone={hasRail(spec.tone) ? spec.tone : undefined} href={routeLink("agents", { filter: navigation.runFilter, return: navigation.returnTo }, run.id)} aria-current={run.id === navigation.runId ? "true" : undefined}>
              <span className="row-main">
                <StatusIcon spec={spec} />
                <span className="row-title">{run.title}</span>
                <span className="row-aside">{relative(run.updatedAt)}</span>
                <span className="row-sub"><span>{run.projectName}</span><StatusMark spec={spec} /></span>
                {(run.reason || run.status === "queued") && <span className="row-sub row-reason">{run.reason || "Waiting for capacity, accepted dependencies, and a project slot."}</span>}
              </span>
            </a>;
          })}{!runs.length && <EmptyState title={data.runs.length ? "No runs match this filter" : "No agent runs yet"}>Start with one bounded assignment. Execution requires explicit authorization.</EmptyState>}</div>
          {navigation.runId ? <section className="workspace-detail" aria-label="Run workspace"><AgentRunWorkspace key={navigation.runId} id={navigation.runId} polling={live} refresh={refresh} onSaved={() => setRefresh(value => value + 1)} returnTo={navigation.returnTo} /></section> : <EmptyState title={navigation.invalidRun ? "This run link is invalid" : "Choose a run"} action={navigation.invalidRun ? <Button component="a" href="#agents" variant="default">All runs</Button> : undefined}>Inspect the response and evidence before accepting work.</EmptyState>}
        </div>
        {data.runs.length === 200 && <Text size="sm">Showing the latest 200 loaded runs, with unresolved work first.</Text>}
      </>}
    </>}
  </Stack>;
}
function RuntimeSettings({ initial, onSaved }: { initial: AgentSettings; onSaved: () => void }) {
  const [value, setValue] = useState(initial), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saved = useRef(JSON.stringify(initial)), lock = useRef(false);
  useDraftGuard(JSON.stringify(value) !== saved.current, hash => { const route = parseRoute(hash); return route.destination === "agents" && route.view === "settings"; });
  const save = async () => { if (lock.current) return; lock.current = true; setBusy(true); setError(""); try { const s = await deliveryApi<AgentSettings>("/api/agents/settings", { ...value, acknowledgeRisk: ack }); saved.current = JSON.stringify(s); setValue(s); onSaved(); } catch(e) { setError(errorText(e)); } finally { setBusy(false); lock.current = false; } };
  const state = EXECUTION[initial.enabled ? initial.paused ? "paused" : "enabled" : "disabled"];
  return <details open={!initial.enabled} className="settings-panel"><summary><StatusIcon spec={state} /> Execution {initial.enabled ? initial.paused ? "paused" : "enabled" : "disabled"} · limits and permissions</summary><Stack gap="sm" mt="sm">
    <Alert color="orange" icon={<TriangleAlert size={18} aria-hidden="true" />} title="Runs use your local agent account">Agents and approved checks can execute commands and access your machine and network. They may incur provider charges. A worktree separates files, not permissions. EZCoder currently runs without approval prompts. No automatic commits, merges, deployments or workspace deletion are performed by DAVE.</Alert>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Checkbox label="Enable local agent execution" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.currentTarget.checked })} />
    <Checkbox label="Pause new starts (running work continues)" checked={value.paused} onChange={e => setValue({ ...value, paused: e.currentTarget.checked })} />
    <Group grow align="flex-start">{([["maxConcurrent", "Active runs across all projects", 6], ["maxPerProject", "Active runs per project", 3], ["reviewLimit", "Pause new starts at this review backlog", 12], ["timeoutMinutes", "Maximum minutes per agent turn", 120]] as const).map(([key,label,max]) => <NumberInput key={key} label={label} min={1} max={max} value={value[key]} onChange={v => setValue({ ...value, [key]: Number(v) })} />)}</Group>
    {!initial.enabled && <Checkbox label="I understand these agents are not sandboxed and may use my paid account" checked={ack} onChange={e => setAck(e.currentTarget.checked)} />}
    <Button loading={busy} disabled={value.enabled && !initial.enabled && !ack} onClick={() => void save()}>Save execution settings</Button>
  </Stack></details>;
}
