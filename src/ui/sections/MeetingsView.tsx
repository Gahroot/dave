import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { CircleCheck, Plug, Settings, Sparkles, Unplug } from "lucide-react";
import { CountPill, StatusIcon, StatusMark } from "../components/Status.tsx";
import { MEETING_STATUS as MEETING_MARK, PROMISE_GROUP } from "../status.ts";
import type { MeetingItem, MeetingRow, MeetingsState } from "../../meetings/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { relative } from "../format.ts";
import { groupPromises, MEETING_STATUS_LABELS } from "../meetings-model.ts";
import { parseRoute, routeLink, type MeetingSection } from "../navigation.ts";
import { EmptyState, PageHeader, PanelHead } from "../components/WorkspacePrimitives.tsx";
import { MeetingItemRow, type ItemAction } from "../components/MeetingItemRow.tsx";
import { MeetingDetail } from "./MeetingDetail.tsx";
import { MeetingInstructions } from "./MeetingInstructions.tsx";

type Items = { promises: MeetingItem[]; asks: MeetingItem[] };
const SECTIONS: readonly { id: MeetingSection; label: string }[] = [
  { id: "promises", label: "Your promises" },
  { id: "asks", label: "Client asks" },
  { id: "list", label: "Meetings" },
  { id: "instructions", label: "Reading instructions" },
];
const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";

/** Promises, client asks and meetings from Fathom. One owner for this page's reads and polling. */
export function MeetingsView({ route, paused = false, refreshedAt = null }: { route: string; paused?: boolean; refreshedAt?: string | null }) {
  const navigation = parseRoute(route);
  const section = navigation.section;
  const [state, setState] = useState<MeetingsState | null>(null);
  const [items, setItems] = useState<Items | null>(null);
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [error, setError] = useState(""), [busyId, setBusyId] = useState<string | null>(null), [version, setVersion] = useState(0);
  const lock = useRef(false);
  const reload = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const [s, i, m] = await Promise.all([
          deliveryApi<MeetingsState>("/api/meetings/status", undefined, ac.signal),
          deliveryApi<Items>("/api/meetings/items", undefined, ac.signal),
          deliveryApi<{ meetings: MeetingRow[] }>("/api/meetings/recordings", undefined, ac.signal),
        ]);
        if (!ac.signal.aborted) { setState(s); setItems(i); setMeetings(m.meetings); setError(""); }
      } catch (e) { if (!ac.signal.aborted) setError(errorText(e)); }
    })();
    return () => ac.abort();
    // The app's Refresh and auto-updates bring meeting data up to date too.
  }, [version, refreshedAt]);

  // Poll only while a sync or analysis is running, and only while visible.
  const active = !!state && (state.sync.running || !!state.analysis.running || state.analysis.queued.length > 0);
  useEffect(() => {
    if (!active || paused) return;
    const timer = setTimeout(() => { if (document.visibilityState === "visible") reload(); }, 3000);
    return () => clearTimeout(timer);
  }, [active, paused, state, reload]);

  const onAction = async (item: MeetingItem, action: ItemAction) => {
    if (lock.current) return;
    lock.current = true; setBusyId(item.id); setError("");
    try { await deliveryApi(`/api/meetings/items/${encodeURIComponent(item.id)}/status`, { action }); reload(); }
    catch (e) { setError(errorText(e)); }
    finally { lock.current = false; setBusyId(null); }
  };

  const here = routeLink("meetings", { section: section === "promises" ? null : section });
  if (navigation.rec) return <MeetingDetail recordingId={navigation.rec} back={routeLink("meetings", { section: "list" })} state={state} onChanged={reload} paused={paused} />;

  const connected = !!state?.key.saved && !!state.settings.connectedAt;
  const promiseGroups = items ? groupPromises(items.promises, new Date()) : [];
  const count = (id: MeetingSection) => id === "promises" ? items?.promises.length : id === "asks" ? items?.asks.length : id === "list" ? meetings?.length : undefined;
  return <Stack gap="md">
    <PageHeader title="Meetings" actions={<Button component="a" href={routeLink("connections")} variant="subtle" color="dark" leftSection={<Settings size={16} aria-hidden="true" />}>Fathom settings</Button>} />
    {state && <div className="count-strip" role="group" aria-label="Meeting sync">
      <StatusMark spec={connected ? { tone: "green", icon: Plug, label: "Fathom connected" } : { tone: "gray", icon: Unplug, label: "Fathom not connected" }} />
      <StatusMark spec={state.analysis.running ? { tone: "blue", icon: Sparkles, label: "", spin: false } : state.analysis.on ? { tone: "green", icon: Sparkles, label: "" } : { tone: "gray", icon: Sparkles, label: "" }}>{state.analysis.running ? `Analyzing${state.analysis.queued.length ? `, ${state.analysis.queued.length} waiting` : ""}` : state.analysis.on ? "Analysis on" : state.analysis.consentOutdated ? "Analysis paused" : "Analysis off"}</StatusMark>
      {state.sync.lastSuccessAt && <StatusMark spec={{ tone: "gray", icon: CircleCheck, label: "" }}>Checked {relative(state.sync.lastSuccessAt)}</StatusMark>}
    </div>}
    {state && !connected && <Alert title="Connect Fathom to import meetings" icon={<Unplug size={18} aria-hidden="true" />}>Add your Fathom API key and email in Connections. DAVE imports only meetings you recorded.</Alert>}
    {state && connected && !state.analysis.on && <Text size="sm" c="dimmed">{state.analysis.consentOutdated ? "Automatic analysis is paused until you review what DAVE sends." : "Automatic analysis is off."} Open a meeting to analyze it, or turn analysis on in Fathom settings.</Text>}
    {state?.analysis.running && <Text size="sm" role="status" className="visually-hidden">Analyzing a meeting{state.analysis.queued.length ? `, ${state.analysis.queued.length} more waiting` : ""}…</Text>}
    {error && <Alert color="red" title="Meetings need attention" role="alert">{error}</Alert>}
    <nav className="workspace-filter" aria-label="Meeting sections">{SECTIONS.map(s => <a key={s.id} href={routeLink("meetings", { section: s.id === "promises" ? null : s.id })} aria-current={section === s.id ? "true" : undefined}>{s.label}{!!count(s.id) && <CountPill value={count(s.id) ?? 0} tone={s.id === "promises" && promiseGroups.some(g => g.id === "overdue") ? "red" : undefined} />}</a>)}</nav>
    {!items && !error && <Text role="status">Loading meetings…</Text>}

    {section === "promises" && items && promiseGroups.length > 0 && <p className="panel-link-row"><a className="panel-link" href={routeLink("cleanup", { bucket: "overdue_promises" })}>Clean up in bulk</a></p>}
    {section === "promises" && items && (promiseGroups.length === 0
      ? <div className="app-panel"><EmptyState title="No open promises">Promises you make in analyzed meetings appear here with the words you used.</EmptyState></div>
      : promiseGroups.map(group => <section key={group.id} aria-labelledby={`promises-${group.id}`} className="meeting-group app-panel">
        <PanelHead id={`promises-${group.id}`} title={group.label} spec={PROMISE_GROUP[group.id]} count={group.items.length} countTone={PROMISE_GROUP[group.id].tone} />
        <ul className="meeting-list">{group.items.map(item => <MeetingItemRow key={item.id} item={item} busy={busyId === item.id} onAction={onAction} returnTo={here} showKind={false} />)}</ul>
      </section>))}

    {section === "asks" && items && (items.asks.length === 0
      ? <div className="app-panel"><EmptyState title="No open client asks">Suggestions and pain points your clients raise appear here, each pain point with a small feature idea.</EmptyState></div>
      : <section className="app-panel" aria-label="Client asks"><ul className="meeting-list">{items.asks.map(item => <MeetingItemRow key={item.id} item={item} busy={busyId === item.id} onAction={onAction} returnTo={here} />)}</ul></section>)}

    {section === "list" && meetings && (meetings.length === 0
      ? <div className="app-panel"><EmptyState title="No meetings imported yet">{connected ? "DAVE checks Fathom every 5 minutes." : "Connect Fathom to start."}</EmptyState></div>
      : <div className="workspace-list app-panel" aria-label="Imported meetings">{meetings.map(m => { const spec = MEETING_MARK[m.status]; return <a key={m.recordingId} className="workspace-row" data-tone={m.status === "failed" ? "red" : undefined} href={routeLink("meetings", { section: "list", rec: m.recordingId })}>
        <span className="row-main">
          <StatusIcon spec={spec} />
          <span className="row-title">{m.headline ?? m.title}</span>
          <span className="row-aside">{new Date(m.startedAt ?? m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span className="row-sub">
            {m.projectName && <span>{m.projectName}</span>}
            <StatusMark spec={spec}>{MEETING_STATUS_LABELS[m.status]}</StatusMark>
            {m.status === "analyzed" && <span className="row-sep">{m.counts.commitment} promise{m.counts.commitment === 1 ? "" : "s"}, {m.counts.pain_point + m.counts.suggestion} client ask{m.counts.pain_point + m.counts.suggestion === 1 ? "" : "s"}</span>}
            {m.staleInstructions && <span className="row-sep">Analyzed with older instructions</span>}
            {(m.skipReason || m.error) && <span className="row-sep">{m.skipReason ?? m.error}</span>}
          </span>
        </span>
      </a>; })}</div>)}

    {section === "instructions" && <div className="app-panel panel-body is-form"><MeetingInstructions state={state} onChanged={reload} /></div>}
  </Stack>;
}
