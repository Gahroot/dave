/**
 * The Inbox tab: port of TodayView + useInboxData + the Inbox logic in App.tsx.
 * A request opens in place of the list (Back returns with filter and page kept);
 * delivery and agent rows push their own screens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { Stack as RouterStack, useFocusEffect, useRouter } from "expo-router";
import { ArrowRight, ChevronLeft, ChevronRight, History, Pause, Play, RefreshCw } from "lucide-react-native";
import type { AgentOverview } from "../../../../src/agents/types.ts";
import type { AttentionAction, Portfolio } from "../../../../src/shared/types.ts";
import type { Roadmap } from "../../../../src/model/roadmap.ts";
import type { InboxFilter } from "../../../../src/ui/navigation.ts";
import { groupInbox, inboxCounts, inboxDisplayOrder, inboxSourceStatus, normalizeInbox, type DeliveryQueueData, type InboxRow } from "../../../../src/ui/inbox-model.ts";
import { pickTopAction, type TopAction } from "../../../../src/ui/top-action.ts";
import { FRESHNESS, INBOX_CATEGORY } from "../../../../src/ui/status.ts";
import { relative } from "../../../../src/ui/format.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { usePortfolio } from "../../lib/portfolio";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Caption, Disclosure, EmptyState, ErrorState, Inline, LoadingState, Muted, Panel, Row, Screen, Segmented, Small, tick } from "../../ui/primitives";
import { StatusIcon, StatusMark, CountPill } from "../../ui/status";
import { colors, space, text } from "../../ui/theme";
import { AttentionCard, NextBestAction, RoadmapPanel } from "./InboxCards";
import { FILTERS, PAGE_SIZE, emptyTitle, historyItems, markText, pageCount, pageSlice, resolveMessage, rowParts, rowSpec, rowTarget, topActionTarget } from "./model";

export function InboxScreen() {
  const api = useApi();
  const router = useRouter();
  const live = usePortfolio();
  const [paused, setPaused] = useState(false);
  const agents = useResource<AgentOverview>("/api/agents", { pollMs: paused ? undefined : 10_000 });
  const delivery = useResource<DeliveryQueueData>("/api/delivery/queue");
  const roadmapRes = useResource<{ roadmaps: Roadmap[] }>("/api/delivery/roadmaps");

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [page, setPage] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState(""), [lastId, setLastId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // While an item is open, an action runs, or updates are paused, the list stays put; newer data waits behind "Apply update".
  const [held, setHeld] = useState<Portfolio | null>(null);
  const holding = selectedId !== null || busyId !== null || paused;
  useEffect(() => {
    if (holding) setHeld((current) => current ?? live.data);
    else setHeld(null);
  }, [holding, live.data]);
  const portfolio = held ?? live.data;
  const pending = held !== null && live.data !== null && live.data !== held;
  const saving = useRef(false);

  const errors = {
    agents: agents.error ? "Agent state could not be refreshed." : "",
    delivery: delivery.error ? "Delivery state could not be refreshed." : "",
  };
  const roadmaps = roadmapRes.error ? [] : roadmapRes.data?.roadmaps ?? [];
  const retrySources = () => { void agents.reload(); void delivery.reload(); void roadmapRes.reload(); };

  const rows = useMemo(() => portfolio ? normalizeInbox(portfolio.inbox, agents.data, delivery.data) : [], [portfolio, agents.data, delivery.data]);
  const status = inboxSourceStatus(agents.data, delivery.data, errors);
  const counts = inboxCounts(rows);
  const topAction = pickTopAction(rows, new Date(), roadmaps);
  const filtered = inboxDisplayOrder(rows.filter((row) => filter === "all" || row.category === filter));
  const visible = pageSlice(filtered, page);
  const sections = groupInbox(visible);
  const history = portfolio ? historyItems(portfolio) : [];
  const selected = selectedId && portfolio ? portfolio.inbox.find((item) => item.id === selectedId) ?? null : null;

  // Mark displayed requests as seen (web: on display and when the page becomes visible again).
  const displayed = selectedId ? selected?.id ?? "" : historyOpen ? "" : visible.filter((row) => row.source === "request").map((row) => row.id).join(",");
  const seen = useCallback((ids: string[]) => {
    void api.post("/api/attention/seen", { ids }).catch(() => setActionError("Could not remember which items you viewed. Retry the update."));
  }, [api]);
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (displayed) seen(displayed.split(","));
    return () => { focused.current = false; };
  }, [displayed, seen]));
  useEffect(() => {
    if (!displayed) return;
    const sub = AppState.addEventListener("change", (next) => { if (next === "active" && focused.current) seen(displayed.split(",")); });
    return () => sub.remove();
  }, [displayed, seen]);

  const resolve = async (id: string, action: AttentionAction) => {
    if (saving.current) return;
    saving.current = true;
    setBusyId(id);
    try {
      const result = await api.post<{ portfolio: Portfolio }>(`/api/attention/${id}/${action}`);
      live.setData(result.portfolio);
      setHeld((current) => current ? result.portfolio : null);
      setActionError(null);
      setLastId(action === "undo" ? null : id);
      setMessage(resolveMessage(action));
      tick();
    } catch (e) {
      setActionError(describeError(e, "Action failed"));
      void live.reload();
    } finally { saving.current = false; setBusyId(null); }
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await api.post<Portfolio>("/api/refresh", {}, { timeoutMs: 30_000 });
      live.setData(next); setHeld((current) => current ? next : null); setActionError(null);
    } catch (e) { setActionError(describeError(e, "Update failed")); }
    finally { setRefreshing(false); }
    retrySources();
  };
  const applyUpdate = () => { if (live.data) setHeld(live.data); };

  const openRow = (row: InboxRow) => {
    const path = rowTarget(row);
    if (path) router.push(path); else setSelectedId(row.id);
  };
  const openTop = (action: TopAction) => {
    const target = topActionTarget(action);
    if (!target) return;
    if ("path" in target) router.push(target.path); else setSelectedId(target.request);
  };

  const feedback = !!message && <Banner tone="green" title={message} action={lastId ? <Button title="Undo last action" compact disabled={!!busyId} style={styles.start} onPress={() => void resolve(lastId, "undo")} /> : undefined} />;
  const errorBanner = <>
    {!!actionError && <Banner tone="red" title={actionError} action={<Button title="Retry" icon={RefreshCw} compact style={styles.start} onPress={() => { setActionError(null); void live.reload(); }} />} />}
    {!!live.error && !!live.data && <Banner tone="red" title="Update failed" message={`${live.error} Showing the last loaded inbox; it may be stale.`} action={<Button title="Retry" icon={RefreshCw} compact style={styles.start} onPress={() => void live.reload()} />} />}
    {pending && <Banner tone="blue" title="Updated information is ready" message={selectedId ? "Your open item has stayed in place." : "The list has stayed in place."} action={<Button title="Apply update" compact variant="primary" disabled={!!busyId} style={styles.start} onPress={applyUpdate} />} />}
  </>;

  const header = <RouterStack.Screen options={{ title: "Inbox" }} />;

  if (!portfolio) return <Screen>{header}{live.loading || !live.error ? <LoadingState label="Loading inbox…" /> : <ErrorState message={live.error} onRetry={() => void live.reload()} />}</Screen>;

  if (selectedId) return <Screen onRefresh={() => void live.reload()} refreshing={live.refreshing}>
    {header}
    <Button title="Back to inbox" variant="subtle" icon={ChevronLeft} style={styles.start} onPress={() => setSelectedId(null)} />
    {feedback}{errorBanner}
    <Panel title={selected?.title ?? "Selected work"}>
      {selected ? <AttentionCard item={selected} portfolio={portfolio} compact busyId={busyId} onResolve={(id, action) => void resolve(id, action)} />
        : <EmptyState title="This request is no longer in the queue" message="Check History for saved decisions." />}
    </Panel>
  </Screen>;

  const coverage = portfolio.coverage;
  const overCapacity = delivery.data && delivery.data.entries.filter((entry) => entry.state === "active").length > delivery.data.limit;
  const total = historyOpen ? history.length : filtered.length;

  return <Screen onRefresh={() => void refresh()} refreshing={refreshing}>
    {header}
    <Inline>
      <Button title={`History / snoozed (${history.length})`} variant="subtle" icon={History} compact onPress={() => { setHistoryOpen((v) => !v); setPage(0); }} />
      <Button title="Refresh" variant="subtle" icon={RefreshCw} compact loading={refreshing} disabled={!!busyId} onPress={() => void refresh()} />
      <Button title={paused ? "Resume auto-updates" : "Pause auto-updates"} variant="subtle" icon={paused ? Play : Pause} compact onPress={() => setPaused((v) => !v)} />
    </Inline>
    {errorBanner}
    {!historyOpen && <NextBestAction action={topAction} onOpen={openTop} />}
    {!historyOpen && <RoadmapPanel roadmaps={roadmaps} />}
    <View accessibilityLabel="What this inbox covers" style={styles.strip}>
      <StatusMark spec={FRESHNESS.checked}><Text style={styles.bold}>{coverage?.checked ?? 0}</Text> checked</StatusMark>
      {!!coverage?.cached && <StatusMark spec={FRESHNESS.cached}><Text style={styles.bold}>{coverage.cached}</Text> cached</StatusMark>}
      {!!coverage?.unavailable && <StatusMark spec={FRESHNESS.unavailable}><Text style={styles.bold}>{coverage.unavailable}</Text> unavailable</StatusMark>}
      {!!portfolio.newCount && <Small><Text style={styles.bold}>{portfolio.newCount}</Text> new</Small>}
    </View>
    <Disclosure title="What checked and cached mean">
      <StatusMark spec={FRESHNESS.checked}>Checked: DAVE re-read this project during the latest scan.</StatusMark>
      <StatusMark spec={FRESHNESS.cached}>Cached: shown from an earlier scan; not deep checked this time.</StatusMark>
      <StatusMark spec={FRESHNESS.unavailable}>Unavailable: DAVE could not read it. It may still need you.</StatusMark>
      <Small>{rows.length} items are loaded in this inbox.</Small>
    </Disclosure>
    {!!coverage?.waitingOutsideCap && <Button title={`${coverage.waitingOutsideCap} waiting projects outside the scan`} variant="subtle" icon={ArrowRight} compact style={styles.start}
      accessibilityLabel="View waiting projects" onPress={() => router.push("/(tabs)/projects?waiting=1")} />}
    {status.agentsCapped && <Muted>Agent counts cover the latest 200 loaded runs.</Muted>}
    {status.unavailable.map((name) => <Banner key={name} tone="red" title={`${name === "agents" ? "Agent attention" : "Delivery list"} unavailable`}
      message={`${name === "agents" ? errors.agents : errors.delivery} Any retained rows may be stale. Other sources remain available.`}
      action={<Button title="Retry source reads" variant="subtle" icon={RefreshCw} compact style={styles.start} onPress={retrySources} />} />)}
    {overCapacity && delivery.data && <Banner tone="amber" title="More on the go than you can finish" message={`Open a delivery to pause it. Capacity: ${delivery.data.limit} at a time.`} />}
    {feedback}
    {historyOpen ? <>
      <Button title="Back to inbox" variant="subtle" icon={ChevronLeft} style={styles.start} onPress={() => { setHistoryOpen(false); setPage(0); }} />
      {pageSlice(history, page).map((item) => <Panel key={item.id} title={item.title}>
        <AttentionCard item={item} portfolio={portfolio} history compact busyId={busyId} onResolve={(id, action) => void resolve(id, action)} />
      </Panel>)}
      {!history.length && <Panel><EmptyState title="No saved history here" /></Panel>}
    </> : <>
      <Segmented label="Inbox filters" value={filter} onChange={(next) => { setFilter(next); setPage(0); }}
        options={FILTERS.map(([value, label]) => ({ value, label, count: counts[value] }))} />
      {sections.map((section) => {
        const spec = INBOX_CATEGORY[section.category];
        return <Panel key={section.category} title={spec.label} spec={spec} count={counts[section.category]} padded={false}>
          {section.clusters.map((cluster) => {
            const lead = cluster.rows[0];
            if (!lead) return null;
            if (cluster.rows.length === 1) return <InboxRowView key={lead.key} row={lead} group={null} onPress={openRow} />;
            const leadSpec = rowSpec(lead);
            const sharedReason = cluster.rows.every((row) => row.reason === lead.reason);
            return <View key={lead.key} accessibilityLabel={`${cluster.ask}, ${cluster.rows.length} projects`} style={styles.cluster}>
              <View style={styles.clusterHead}>
                <StatusIcon spec={leadSpec} />
                <Text style={[text.body, styles.bold, styles.flex]} selectable>{cluster.ask}</Text>
                <CountPill value={cluster.rows.length} tone={leadSpec.tone} />
              </View>
              <View style={styles.clusterNote}>
                <StatusMark spec={leadSpec}>{markText(lead)}</StatusMark>
                {sharedReason && !!lead.reason && lead.reason !== cluster.ask && <Caption>{lead.reason}</Caption>}
                <Caption>same ask in each</Caption>
              </View>
              {cluster.rows.map((row) => <InboxRowView key={row.key} row={row} group={{ lead, sharedReason }} onPress={openRow} />)}
            </View>;
          })}
        </Panel>;
      })}
      {!visible.length && <Panel><EmptyState title={emptyTitle(page, rows.length)} message="Unchecked or unavailable projects may still need you."
        action={page > 0 ? <Button title="First page" variant="subtle" onPress={() => setPage(0)} /> : undefined} /></Panel>}
    </>}
    {(total > PAGE_SIZE || page > 0) && <Inline>
      <Small>Page {page + 1} of {pageCount(total)}</Small>
      <Button title="Previous" variant="subtle" icon={ChevronLeft} compact disabled={!page} onPress={() => setPage((p) => p - 1)} />
      <Button title="Next" variant="subtle" icon={ChevronRight} compact disabled={(page + 1) * PAGE_SIZE >= total} onPress={() => setPage((p) => p + 1)} />
    </Inline>}
  </Screen>;
}

function InboxRowView({ row, group, onPress }: { row: InboxRow; group: { lead: InboxRow; sharedReason: boolean } | null; onPress: (row: InboxRow) => void }) {
  const spec = rowSpec(row);
  const { title, showMark, showReason } = rowParts(row, group);
  const shared = !!group;
  return <Row title={title} spec={shared ? undefined : spec} showRail={!shared} onPress={() => onPress(row)}
    accessibilityLabel={`${title}${shared ? "" : `, ${row.project}`}, ${markText(row)}`}
    right={row.timestamp ? <Caption>{relative(row.timestamp)}</Caption> : undefined}
    subtitle={(!shared || showMark || showReason) ? <View style={styles.sub}>
      {!shared && <Muted numberOfLines={2}>{row.project}</Muted>}
      {showMark && <StatusMark spec={spec}>{markText(row)}</StatusMark>}
      {showReason && <Muted numberOfLines={3}>{row.reason}</Muted>}
    </View> : undefined} />;
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  flex: { flex: 1, minWidth: 0 },
  start: { alignSelf: "flex-start" },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" },
  cluster: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  clusterHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md },
  clusterNote: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.xs },
  sub: { gap: space.xxs },
});
