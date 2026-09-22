import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { AttentionAction, InboxItem, Portfolio } from "../../shared/types.ts";
import { InboxView } from "./InboxView.tsx";
import { LazyDeliveryView as DeliveryView } from "./LazyDeliveryView.tsx";
import { DeliveryQueue } from "./DeliveryQueue.tsx";
import { AgentAttention } from "./AgentAttention.tsx";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
import { parseRoute, routeLink } from "../navigation.ts";
import { normalizeInbox, inboxSourceStatus } from "../inbox-model.ts";
import { useInboxData } from "../hooks/useInboxData.ts";
import { relative } from "../format.ts";

export function TodayView({ portfolio, busyId, onResolve, onSeen, actions, paused = false, route }: {
  portfolio: Portfolio; route: string; paused?: boolean; busyId: string | null;
  onResolve: (id: string, action: AttentionAction) => Promise<boolean>;
  onSeen: (ids: string[]) => void; actions?: (item: InboxItem) => ReactNode;
}) {
  const navigation = parseRoute(route);
  const [historyOpen, setHistoryOpen] = useState(false), [page, setPage] = useState(0);
  const [message, setMessage] = useState(""), [lastId, setLastId] = useState<string | null>(null);
  const heading = useRef<HTMLDivElement>(null);
  const source = useInboxData(paused, navigation.delivery);
  const rows = normalizeInbox(portfolio.inbox, source.agents, source.delivery);
  const status = inboxSourceStatus(source.agents, source.delivery, source.errors);
  const filtered = rows.filter(row => navigation.filter === "all" || row.category === navigation.filter);
  const visible = filtered.slice(page * 100, page * 100 + 100);
  const selectedRequest = portfolio.inbox.find(item => item.id === navigation.item);
  const selectedProject = [...portfolio.active, ...portfolio.other].find(project => project.id === navigation.delivery && !project.override.hidden);
  const selected = navigation.item || navigation.delivery;
  const history = (portfolio.history ?? []).filter(item => !portfolio.inbox.some(open => open.id === item.id));
  const displayed = visible.filter(row => row.source === "request").map(row => row.id).join(",");
  useEffect(() => {
    if (!displayed || historyOpen) return;
    const mark = () => { if (document.visibilityState === "visible") onSeen(displayed.split(",")); };
    mark(); document.addEventListener("visibilitychange", mark); return () => document.removeEventListener("visibilitychange", mark);
  }, [displayed, historyOpen, onSeen]);
  useEffect(() => { setPage(0); }, [navigation.filter]);
  const resolve = async (id: string, action: AttentionAction) => {
    if (await onResolve(id, action)) {
      setLastId(action === "undo" ? null : id);
      setMessage(action === "undo" ? "Reopened locally if this evidence is still current." : action === "tomorrow" ? "Snoozed until 09:00 tomorrow. See History for the stored deadline." : "Saved locally. Upstream tasks are unchanged.");
      heading.current?.focus();
    }
  };
  return <Stack gap="md">
    <Group justify="space-between"><div ref={heading} tabIndex={-1}><PageHeader title="Inbox" /></div><Button variant="subtle" color="dark" aria-pressed={historyOpen} onClick={() => { setHistoryOpen(v => !v); setPage(0); }}>History / snoozed ({history.length})</Button></Group>
    <Text size="sm" c="dimmed">{rows.length} loaded items · {portfolio.newCount ?? 0} new requests · Coverage: {portfolio.coverage?.checked ?? 0} checked · {portfolio.coverage?.cached ?? 0} cached / not deep checked · {portfolio.coverage?.unavailable ?? 0} unavailable</Text>
    {!!portfolio.coverage?.waitingOutsideCap && <Text size="sm"><a className="coverage-link" href="#projects?waiting=1" aria-label="View waiting projects">{portfolio.coverage.waitingOutsideCap} waiting projects outside the scan</a></Text>}
    {status.agentsCapped && <Text size="sm">Agent counts cover the latest 200 loaded runs.</Text>}
    {status.unavailable.map(name => <Alert key={name} title={`${name === "agents" ? "Agent attention" : "Delivery list"} unavailable`} role="alert">{source.errors[name as keyof typeof source.errors]} Any retained rows may be stale. Other sources remain available. <Button variant="default" onClick={source.retry}>Retry source reads</Button></Alert>)}
    {source.delivery && source.delivery.entries.filter(entry => entry.state === "active").length > source.delivery.limit && <Alert title="More on the go than you can finish">Open a delivery to pause it. Capacity: {source.delivery.limit} at a time.</Alert>}
    <div role="status" hidden={!message}>{message}{lastId && <Button ml="xs" variant="default" disabled={!!busyId} onClick={() => void resolve(lastId, "undo")}>Undo last action</Button>}</div>
    {historyOpen ? <><Button variant="default" onClick={() => setHistoryOpen(false)}>Back to inbox</Button><InboxView items={history.slice(page * 100, page * 100 + 100)} history busyId={busyId} onResolve={(id, action) => void resolve(id, action)} actions={actions} />{!history.length && <EmptyState title="No saved history here" />}{history.length > 100 && <Group><Button variant="default" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="default" disabled={(page + 1) * 100 >= history.length} onClick={() => setPage(value => value + 1)}>Next</Button></Group>}</> : <>
      <nav className="workspace-filter" aria-label="Inbox filters">{([['all', 'All'], ['decision', 'Needs decision'], ['ready', 'Ready to work'], ['waiting', 'Waiting']] as const).map(([filter, label]) => <a key={filter} href={routeLink("queue", { filter, item: navigation.item, delivery: navigation.delivery })} aria-current={navigation.filter === filter ? "true" : undefined}>{label}</a>)}</nav>
      <div className={`workspace-split inbox-workspace${selected ? " has-selection" : ""}`}>
        <div className="workspace-list" aria-label="Attention list">
          {visible.map(row => <a className="workspace-row" key={row.key} data-inbox-key={row.key} data-queue-entry={row.source === "delivery" ? row.id : undefined} href={row.source === "agent" ? routeLink("agents", { return: route }, row.id) : routeLink("queue", { filter: navigation.filter, [row.source === "request" ? "item" : "delivery"]: row.id })} aria-current={(row.source === "request" && navigation.item === row.id) || (row.source === "delivery" && navigation.delivery === row.id) ? "true" : undefined}>
            <div className="row-identity"><Text size="sm" fw={500}>{row.project}</Text><Text size="xs" c="dimmed">{row.source === "agent" ? "Agent run" : row.source === "delivery" ? "Delivery" : "Project request"}</Text></div><div className="row-content">{row.source === "agent" ? <AgentAttention run={row.value} /> : row.source === "delivery" ? <DeliveryQueue entry={row.value} /> : <><Text fw={500}>{row.title}</Text><Text size="sm" c="dimmed">{row.reason}</Text></>}</div><Text className="row-time" size="xs" c="dimmed">{relative(row.timestamp)}</Text>
          </a>)}
          {!visible.length && <EmptyState title={rows.length ? "Nothing matches this filter" : "No current attention in loaded evidence"}>Unchecked or unavailable projects may still need you.</EmptyState>}
          {filtered.length > 100 && <Group p="sm"><Button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</Button><Button disabled={(page + 1) * 100 >= filtered.length} onClick={() => setPage(p => p + 1)}>Next</Button></Group>}
        </div>
        {selected ? <section className="workspace-detail" aria-label="Selected work"><Stack gap="md"><Button component="a" variant="default" href={routeLink("queue", { filter: navigation.filter })} onClick={() => { const key = navigation.item ? `request:${navigation.item}` : `delivery:${navigation.delivery}`; requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-inbox-key="${key}"]`)?.focus()); }}>Back to inbox</Button>
          {navigation.item && (selectedRequest ? <><InboxView items={[selectedRequest]} busyId={busyId} onResolve={(id, action) => void resolve(id, action)} actions={actions} /><Text size="sm">Handled remembers this evidence locally. It does not complete upstream work.</Text></> : <EmptyState title="This request is no longer in the queue">Check History for saved decisions.</EmptyState>)}
          {navigation.delivery && (selectedProject ? <DeliveryView key={selectedProject.id} project={selectedProject} today /> : <Alert title="That project is unavailable">It is hidden or no longer discovered. Open <a href="#projects?hidden=1">hidden projects</a> to recover it.</Alert>)}
        </Stack></section> : <EmptyState title="Choose what needs attention">Open a row to inspect its context and next action.</EmptyState>}
      </div>
    </>}
  </Stack>;
}
