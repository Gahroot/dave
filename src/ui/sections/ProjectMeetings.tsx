import { useEffect, useRef, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { ArrowRight, CircleCheck, Handshake, MessageSquareWarning, TriangleAlert } from "lucide-react";
import { CountPill, StatusIcon, StatusTile } from "../components/Status.tsx";
import { PanelHead } from "../components/WorkspacePrimitives.tsx";
import type { StatusSpec } from "../status.ts";
import type { MeetingItem, ProjectMeetingsOverview, PromiseStateName } from "../../meetings/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { routeLink } from "../navigation.ts";
import { MeetingItemRow, type ItemAction } from "../components/MeetingItemRow.tsx";

const OVERLOOKED: readonly PromiseStateName[] = ["overdue", "not_followed_up"];
const STATE_NOTE: Record<PromiseStateName, string> = { overdue: "Overdue", due_soon: "Due soon", not_followed_up: "No work since the call", open: "" };
const EVIDENCE_LABEL = { commit: "Commit", run: "Accepted agent run", milestone: "Finished milestone", task: "Done task" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const FROM_MEETINGS: StatusSpec = { tone: "blue", icon: Handshake, label: "From meetings" };

/**
 * "From meetings" on the project Work tab: what was promised, what the client
 * asked for, and what happened since the last call. Loads nothing when the
 * project has no meetings, and never calls the model.
 */
export function ProjectMeetings({ projectId, returnTo }: { projectId: string; returnTo: string }) {
  const [data, setData] = useState<ProjectMeetingsOverview | null>(null);
  const [error, setError] = useState(""), [busyId, setBusyId] = useState<string | null>(null), [version, setVersion] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    deliveryApi<ProjectMeetingsOverview>(`/api/meetings/projects/${encodeURIComponent(projectId)}`, undefined, ac.signal)
      .then(value => { if (!ac.signal.aborted) { setData(value); setError(""); } })
      .catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Meeting context unavailable."); });
    return () => ac.abort();
  }, [projectId, version]);
  const onAction = async (item: MeetingItem, action: ItemAction) => {
    if (lock.current) return;
    lock.current = true; setBusyId(item.id); setError("");
    try { await deliveryApi(`/api/meetings/items/${encodeURIComponent(item.id)}/status`, { action }); setVersion(v => v + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed. Retry."); }
    finally { lock.current = false; setBusyId(null); }
  };

  if (error && !data) return <Alert color="red" title="Meeting context unavailable" role="alert">{error}</Alert>;
  if (!data || (data.items.length === 0 && !data.lastCall)) return null;

  const promises = data.items.filter(i => i.kind === "commitment");
  const state = (i: MeetingItem) => data.promiseStates[i.id] ?? "open";
  const overlooked = promises.filter(i => i.status === "open" && OVERLOOKED.includes(state(i)));
  const open = promises.filter(i => (i.status === "open" && !OVERLOOKED.includes(state(i))) || i.status === "looks_done");
  const done = promises.filter(i => i.status === "done");
  const asks = data.items.filter(i => (i.kind === "pain_point" || i.kind === "suggestion") && ["open", "planned", "looks_done"].includes(i.status));
  const row = (item: MeetingItem) => <MeetingItemRow key={item.id} item={item} busy={busyId === item.id} onAction={onAction} returnTo={returnTo} showProject={false} showKind={item.kind !== "commitment"}
    flag={item.kind === "commitment" && item.status === "open" ? STATE_NOTE[state(item)] : ""} />;
  const group = (id: string, title: string, items: MeetingItem[], spec: StatusSpec) => items.length > 0 && <section aria-labelledby={id} className="meeting-group">
    <h3 className="panel-subhead" id={id}><StatusTile spec={spec} />{title} <CountPill value={items.length} tone={spec.tone} decorative={false} /></h3>
    <ul className="meeting-list">{items.map(row)}</ul>
  </section>;

  return <section aria-labelledby={`project-meetings-${projectId}`} className="project-meetings app-panel">
    <PanelHead id={`project-meetings-${projectId}`} title="From meetings" spec={FROM_MEETINGS}
      actions={<Button component="a" variant="subtle" color="dark" rightSection={<ArrowRight size={16} aria-hidden="true" />} href={routeLink("meetings")}>All meetings</Button>} />
    {(error || data.lastCall) && <Stack gap="sm" className="panel-body">
      {error && <Alert color="red" title="Action needs attention" role="alert">{error}</Alert>}
      {data.lastCall && <Stack gap={4} className="meeting-prose">
        <Text size="sm">Last call: <a href={routeLink("meetings", { section: "list", rec: data.lastCall.recordingId })}>{data.lastCall.title}</a>, {day(data.lastCall.at)}{data.lastCall.headline ? `. ${data.lastCall.headline}` : ""}</Text>
        {data.lastCall.direction.length > 0 && <ul className="meeting-checks">{data.lastCall.direction.map(d => <li key={d}><Text size="sm">{d}</Text></li>)}</ul>}
      </Stack>}
      {data.lastCall && <details className="quiet-details"><summary>Since your last call ({data.sinceLastCall.length})</summary>
        {data.sinceLastCall.length === 0 ? <Text size="sm">No commits, accepted agent runs, finished milestones or done tasks since that call.</Text>
          : <ul className="meeting-checks">{data.sinceLastCall.map(e => <li key={e.id}><Text size="sm">{EVIDENCE_LABEL[e.kind]}, {day(e.at)}: {e.title}</Text></li>)}</ul>}
      </details>}
    </Stack>}
    {group(`overlooked-${projectId}`, "Overlooked", overlooked, { tone: "red", icon: TriangleAlert, label: "" })}
    {group(`promised-${projectId}`, "Promised", open, { tone: "blue", icon: Handshake, label: "" })}
    {group(`asks-${projectId}`, "Client asks", asks, { tone: "violet", icon: MessageSquareWarning, label: "" })}
    {done.length > 0 && <details className="quiet-details panel-done"><summary><StatusIcon spec={{ tone: "green", icon: CircleCheck, label: "" }} /> Done ({done.length})</summary><ul className="meeting-list">{done.map(row)}</ul></details>}
  </section>;
}
