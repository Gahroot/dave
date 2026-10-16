import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { ArrowRight, ChevronLeft, ChevronRight, History, RefreshCw } from "lucide-react";
import type { AttentionAction, InboxItem, Portfolio } from "../../shared/types.ts";
import { InboxView } from "./InboxView.tsx";
import { LazyDeliveryView as DeliveryView } from "./LazyDeliveryView.tsx";
import { PageHeader, DetailHeader, EmptyState, PanelHead } from "../components/WorkspacePrimitives.tsx";
import { CountPill, HelpTip, StatusIcon, StatusMark } from "../components/Status.tsx";
import { parseRoute, routeLink } from "../navigation.ts";
import { normalizeInbox, inboxSourceStatus, inboxCounts, groupInbox, inboxDisplayOrder, type InboxRow } from "../inbox-model.ts";
import { FRESHNESS, INBOX_CATEGORY, INBOX_KIND, NEXT_STEP, RUN_STATUS, hasRail, type StatusSpec } from "../status.ts";
import { useInboxData } from "../hooks/useInboxData.ts";
import { relative } from "../format.ts";
import { pickTopAction } from "../top-action.ts";
import { NextBestAction } from "../components/NextBestAction.tsx";
import { RoadmapPanel } from "../components/RoadmapPanel.tsx";

const PAGE_SIZE = 100;
const FILTERS = [["all", "All"], ["decision", "Needs decision"], ["ready", "Ready to work"], ["waiting", "Waiting"]] as const;

/** The mark a row leads with: what kind of thing it is and whose move it is. */
function rowSpec(row: InboxRow): StatusSpec {
  if (row.source === "agent") return RUN_STATUS[row.value.status];
  if (row.source === "delivery") return row.value.state === "paused" ? { ...NEXT_STEP.waiting, tone: "gray", label: "Paused" } : NEXT_STEP[row.value.step.kind];
  return INBOX_KIND[row.value.kind];
}
/** The sub-line: project, then what produced it. The ask is either the title or the group header. */
function rowSource(row: InboxRow): string {
  if (row.source === "agent") return "Agent run";
  if (row.source === "delivery") return row.value.state === "paused" ? "Delivery, paused" : "Delivery";
  return INBOX_KIND[row.value.kind].label;
}

export function TodayView({ portfolio, busyId, onResolve, onSeen, actions, paused = false, route }: {
  portfolio: Portfolio; route: string; paused?: boolean; busyId: string | null;
  onResolve: (id: string, action: AttentionAction) => Promise<boolean>;
  onSeen: (ids: string[]) => void; actions?: (item: InboxItem) => ReactNode;
}) {
  const navigation = parseRoute(route);
  const [historyOpen, setHistoryOpen] = useState(false);
  const page = navigation.page - 1;
  const setPage = (value: number | ((previous: number) => number)) => {
    const next = typeof value === "function" ? value(page) : value;
    window.location.hash = routeLink("queue", { filter: navigation.filter, page: String(next + 1) });
  };
  const [message, setMessage] = useState(""), [lastId, setLastId] = useState<string | null>(null);
  const heading = useRef<HTMLDivElement>(null);
  const source = useInboxData(paused, navigation.delivery);
  const rows = normalizeInbox(portfolio.inbox, source.agents, source.delivery);
  const status = inboxSourceStatus(source.agents, source.delivery, source.errors);
  const counts = inboxCounts(rows);
  const topAction = pickTopAction(rows, new Date(), source.roadmaps);
  // Page in the order the groups render, so a shared header never collects rows from other pages.
  const filtered = inboxDisplayOrder(rows.filter(row => navigation.filter === "all" || row.category === navigation.filter));
  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const sections = groupInbox(visible);
  const selectedRequest = portfolio.inbox.find(item => item.id === navigation.item);
  const selectedProject = [...portfolio.active, ...portfolio.other].find(project => project.id === navigation.delivery && !project.override.hidden);
  const selected = navigation.item || navigation.delivery || navigation.invalidSelection;
  const history = (portfolio.history ?? []).filter(item => !portfolio.inbox.some(open => open.id === item.id));
  const displayed = selected ? selectedRequest?.id ?? "" : visible.filter(row => row.source === "request").map(row => row.id).join(",");
  const coverage = portfolio.coverage;
  useEffect(() => {
    if (!displayed || historyOpen) return;
    const mark = () => { if (document.visibilityState === "visible") onSeen(displayed.split(",")); };
    mark(); document.addEventListener("visibilitychange", mark); return () => document.removeEventListener("visibilitychange", mark);
  }, [displayed, historyOpen, onSeen]);

  const resolve = async (id: string, action: AttentionAction) => {
    if (await onResolve(id, action)) {
      setLastId(action === "undo" ? null : id);
      setMessage(action === "undo" ? "Reopened locally if this evidence is still current." : action === "tomorrow" ? "Snoozed until 09:00 tomorrow. See History for the stored deadline." : "Saved locally. Upstream tasks are unchanged.");
      heading.current?.focus();
    }
  };
  const feedback = <div role="status" tabIndex={-1} ref={heading} hidden={!message} className="feedback-line">{message}{lastId && <Button ml="xs" variant="default" size="xs" disabled={!!busyId} onClick={() => void resolve(lastId, "undo")}>Undo last action</Button>}</div>;
  const rowHref = (row: InboxRow) => row.source === "agent" ? routeLink("agents", { return: route }, row.id) : routeLink("queue", { filter: navigation.filter, page: page ? String(page + 1) : null, [row.source === "request" ? "item" : "delivery"]: row.id });
  const markText = (row: InboxRow) => row.source === "request" ? rowSource(row) : `${rowSource(row)} · ${rowSpec(row).label}`;
  /** In a shared group, a member only shows the parts of the sub-line that differ from the group's. */
  const renderRow = (row: InboxRow, group: { lead: InboxRow; sharedReason: boolean } | null) => {
    const spec = rowSpec(row);
    const shared = !!group;
    const title = shared ? row.project : row.title;
    const showMark = !group || markText(row) !== markText(group.lead);
    const showReason = !!row.reason && row.reason !== title && (!group || !group.sharedReason);
    const showSub = !group || showMark || showReason;
    return <a className={`workspace-row${shared ? " is-member" : ""}`} key={row.key} data-tone={!shared && hasRail(spec.tone) ? spec.tone : undefined} data-workspace-focus={row.key} data-inbox-key={row.key} data-queue-entry={row.source === "delivery" ? row.id : undefined} href={rowHref(row)} aria-current={(row.source === "request" && navigation.item === row.id) || (row.source === "delivery" && navigation.delivery === row.id) ? "true" : undefined}>
      <span className="row-main">
        {shared ? <span aria-hidden="true" /> : <StatusIcon spec={spec} />}
        <span className="row-title">{title}</span>
        <span className="row-aside">{row.timestamp ? relative(row.timestamp) : ""}</span>
        {showSub && <span className="row-sub">
          {!shared && <span>{row.project}</span>}
          {showMark && <StatusMark spec={spec}>{markText(row)}</StatusMark>}
          {showReason && <span className={showMark || !shared ? "row-sep" : undefined}>{row.reason}</span>}
        </span>}
      </span>
    </a>;
  };

  if (selected) return <Stack gap="md" className="focused-workspace inbox-workspace">
    <DetailHeader title={selectedRequest?.title ?? selectedProject?.name ?? "Selected work"} back={routeLink("queue", { filter: navigation.filter, page: page ? String(page + 1) : null })} backLabel="Back to inbox" />
    {feedback}
    <section aria-label="Selected work" className="app-panel panel-body">
      {navigation.item && (selectedRequest ? <InboxView items={[selectedRequest]} compact busyId={busyId} onResolve={(id, action) => void resolve(id, action)} actions={actions} /> : <EmptyState title="This request is no longer in the queue">Check History for saved decisions.</EmptyState>)}
      {navigation.delivery && (selectedProject ? <DeliveryView key={selectedProject.id} project={selectedProject} today /> : <Alert color="red" title="That project is unavailable">It is hidden or no longer discovered. Open <a href="#projects?hidden=1">hidden projects</a> to recover it.</Alert>)}
      {navigation.invalidSelection && <EmptyState title="This item is unavailable">Return to the inbox to choose current work.</EmptyState>}
    </section>
  </Stack>;
  return <Stack gap="md">
    <Group justify="space-between" wrap="wrap"><div tabIndex={-1} data-workspace-heading><PageHeader title="Inbox" /></div><Button variant="subtle" color="dark" leftSection={<History size={16} aria-hidden="true" />} aria-pressed={historyOpen} onClick={() => { setHistoryOpen(v => !v); setPage(0); }}>History / snoozed ({history.length})</Button></Group>
    {!historyOpen && <NextBestAction action={topAction} href={a => a.row ? rowHref(a.row) : routeLink("queue", { delivery: a.gap!.projectId })} />}
    {!historyOpen && <RoadmapPanel roadmaps={source.roadmaps} />}
    <div className="count-strip" role="group" aria-label="What this inbox covers">
      <StatusMark spec={FRESHNESS.checked}><strong>{coverage?.checked ?? 0}</strong> checked</StatusMark>
      {!!coverage?.cached && <StatusMark spec={FRESHNESS.cached}><strong>{coverage.cached}</strong> cached</StatusMark>}
      {!!coverage?.unavailable && <StatusMark spec={FRESHNESS.unavailable}><strong>{coverage.unavailable}</strong> unavailable</StatusMark>}
      {!!portfolio.newCount && <span><strong>{portfolio.newCount}</strong> new</span>}
      <HelpTip label="What checked and cached mean">
        <p><StatusMark spec={FRESHNESS.checked} /> DAVE re-read this project during the latest scan.</p>
        <p><StatusMark spec={FRESHNESS.cached} /> Shown from an earlier scan; not deep checked this time.</p>
        <p><StatusMark spec={FRESHNESS.unavailable} /> DAVE could not read it. It may still need you.</p>
        <p>{rows.length} items are loaded in this inbox.</p>
      </HelpTip>
      {!!coverage?.waitingOutsideCap && <a className="coverage-link count-strip-end" href="#projects?waiting=1" aria-label="View waiting projects">{coverage.waitingOutsideCap} waiting projects outside the scan <ArrowRight size={14} aria-hidden="true" /></a>}
    </div>
    {status.agentsCapped && <Text size="sm" c="dimmed">Agent counts cover the latest 200 loaded runs.</Text>}
    {status.unavailable.map(name => <Alert key={name} color="red" title={`${name === "agents" ? "Agent attention" : "Delivery list"} unavailable`} role="alert">{source.errors[name as keyof typeof source.errors]} Any retained rows may be stale. Other sources remain available. <Button variant="subtle" color="dark" size="xs" leftSection={<RefreshCw size={14} aria-hidden="true" />} onClick={source.retry}>Retry source reads</Button></Alert>)}
    {source.delivery && source.delivery.entries.filter(entry => entry.state === "active").length > source.delivery.limit && <Alert color="orange" title="More on the go than you can finish">Open a delivery to pause it. Capacity: {source.delivery.limit} at a time.</Alert>}
    {feedback}
    {historyOpen ? <><Button variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} onClick={() => setHistoryOpen(false)} style={{ alignSelf: "flex-start" }}>Back to inbox</Button><InboxView items={history.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)} history busyId={busyId} onResolve={(id, action) => void resolve(id, action)} actions={actions} />{!history.length && <EmptyState title="No saved history here" />}{history.length > PAGE_SIZE && <Group><Button variant="subtle" color="dark" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="default" disabled={(page + 1) * PAGE_SIZE >= history.length} onClick={() => setPage(value => value + 1)}>Next</Button></Group>}</> : <>
      <nav className="workspace-filter" aria-label="Inbox filters">{FILTERS.map(([filter, label]) => <a key={filter} href={routeLink("queue", { filter, item: navigation.item, delivery: navigation.delivery })} aria-current={navigation.filter === filter ? "true" : undefined}>{label}{!!counts[filter] && <CountPill value={counts[filter]} />}</a>)}</nav>
      <div className="inbox-workspace">
        <div className="workspace-list" aria-label="Attention list">
          {sections.map(section => {
            const spec = INBOX_CATEGORY[section.category];
            return <section key={section.category} className="inbox-section app-panel" aria-labelledby={`inbox-section-${section.category}`} data-tone={spec.tone}>
              <PanelHead id={`inbox-section-${section.category}`} title={spec.label} spec={spec} count={counts[section.category]} countTone={spec.tone} />
              {section.clusters.map(cluster => {
                const lead = cluster.rows[0]!;
                if (cluster.rows.length === 1) return renderRow(lead, null);
                const leadSpec = rowSpec(lead);
                const sharedReason = cluster.rows.every(row => row.reason === lead.reason);
                return <div key={lead.key} className="inbox-cluster" role="group" aria-label={`${cluster.ask}, ${cluster.rows.length} projects`} data-tone={hasRail(leadSpec.tone) ? leadSpec.tone : undefined}>
                  <p className="inbox-cluster-head"><StatusIcon spec={leadSpec} /><span className="inbox-cluster-ask">{cluster.ask} <CountPill value={cluster.rows.length} tone={leadSpec.tone} /></span></p>
                  <p className="inbox-cluster-note"><StatusMark spec={leadSpec}>{markText(lead)}</StatusMark>{sharedReason && lead.reason && lead.reason !== cluster.ask && <span className="row-sep">{lead.reason}</span>}<span className="row-sep">same ask in each</span></p>
                  {cluster.rows.map(row => renderRow(row, { lead, sharedReason }))}
                </div>;
              })}
            </section>;
          })}
          {!visible.length && <div className="app-panel"><EmptyState title={page > 0 ? "No items on this page" : rows.length ? "Nothing matches this filter" : "No current attention in loaded evidence"} action={page > 0 ? <Button variant="subtle" color="dark" onClick={() => setPage(0)}>First page</Button> : undefined}>Unchecked or unavailable projects may still need you.</EmptyState></div>}
          {(filtered.length > PAGE_SIZE || page > 0) && <Group p="sm" gap="xs"><Text size="sm" mr="sm">Page {page + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}</Text><Button variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</Button><Button variant="subtle" color="dark" rightSection={<ChevronRight size={16} aria-hidden="true" />} disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(p => p + 1)}>Next</Button></Group>}
        </div>
      </div>
    </>}
  </Stack>;
}
