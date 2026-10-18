import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { CircleCheck, Plug, Settings, Sparkles, Unplug } from "lucide-react-native";
import type { MeetingItem, MeetingRow, MeetingsState } from "../../../../src/meetings/types.ts";
import { relative } from "../../../../src/ui/format.ts";
import { groupPromises, MEETING_STATUS_LABELS } from "../../../../src/ui/meetings-model.ts";
import { MEETING_STATUS, PROMISE_GROUP } from "../../../../src/ui/status.ts";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Divider, EmptyState, ErrorState, Inline, LoadingState, Muted, Panel, Row, Screen, Segmented, Stack } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";
import { InstructionsPanel } from "./InstructionsPanel";
import { MeetingItemRow } from "./MeetingItemRow";
import { analysisMarkText, fathomConnected, MEETING_SECTIONS, meetingCountsText, meetingsActive, meetingWhen, type MeetingSection } from "./model";
import { useItemAction } from "./useItemAction";

type Items = { promises: MeetingItem[]; asks: MeetingItem[] };

/** Promises, client asks and meetings from Fathom. Polls only while a sync or analysis runs. */
export function MeetingsScreen({ initialSection }: { initialSection: MeetingSection }) {
  const router = useRouter();
  const [section, setSection] = useState<MeetingSection>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  // Poll every 3 s only while a sync or analysis runs, like the web.
  const [active, setActive] = useState(false);
  const pollMs = active ? 3000 : undefined;
  const status = useResource<MeetingsState>("/api/meetings/status", { pollMs });
  const items = useResource<Items>("/api/meetings/items", { pollMs });
  const recordings = useResource<{ meetings: MeetingRow[] }>("/api/meetings/recordings", { pollMs });
  const state = status.data;
  useEffect(() => setActive(meetingsActive(state)), [state]);

  const reload = useCallback(() => Promise.all([status.reload(), items.reload(), recordings.reload()]), [status, items, recordings]);
  const actions = useItemAction(reload);
  const connected = fathomConnected(state);
  const promiseGroups = items.data ? groupPromises(items.data.promises, new Date()) : [];
  const error = status.error ?? items.error ?? recordings.error;
  const count = (id: MeetingSection) => id === "promises" ? items.data?.promises.length : id === "asks" ? items.data?.asks.length : id === "list" ? recordings.data?.meetings.length : undefined;
  const analysisSpec: StatusSpec | null = state ? { tone: state.analysis.running ? "blue" : state.analysis.on ? "green" : "gray", icon: Sparkles, label: "" } : null;

  return <Screen refreshing={status.refreshing || items.refreshing || recordings.refreshing} onRefresh={() => void reload()}>
    <Panel title="Meeting sync" actions={<Button title="Fathom settings" icon={Settings} variant="subtle" compact onPress={() => router.push("/connections")} />}>
      {state ? <Inline gap={12}>
        <StatusMark spec={connected ? { tone: "green", icon: Plug, label: "Fathom connected" } : { tone: "gray", icon: Unplug, label: "Fathom not connected" }} />
        {analysisSpec && <StatusMark spec={analysisSpec}>{analysisMarkText(state)}</StatusMark>}
        {state.sync.lastSuccessAt && <StatusMark spec={{ tone: "gray", icon: CircleCheck, label: "" }}>Checked {relative(state.sync.lastSuccessAt)}</StatusMark>}
      </Inline> : !status.error && <Muted>Loading status…</Muted>}
      {state && !connected && <Banner title="Connect Fathom to import meetings" message="Add your Fathom API key and email in Connections. DAVE imports only meetings you recorded."
        action={<Button title="Open Connections" compact onPress={() => router.push("/connections")} />} />}
      {state && connected && !state.analysis.on && <Muted>{state.analysis.consentOutdated ? "Automatic analysis is paused until you review what DAVE sends." : "Automatic analysis is off."} Open a meeting to analyze it, or turn analysis on in Fathom settings.</Muted>}
      {error && <Banner tone="red" title="Meetings need attention" message={error} action={<Button title="Retry" compact onPress={() => void reload()} />} />}
      <Segmented label="Meeting sections" value={section} onChange={setSection}
        options={MEETING_SECTIONS.map((s) => ({ value: s.id, label: s.label, count: count(s.id),
          tone: s.id === "promises" && promiseGroups.some((g) => g.id === "overdue") ? "red" as const : undefined }))} />
    </Panel>

    {section !== "instructions" && !items.data && !error && <LoadingState label="Loading meetings…" />}
    {section !== "instructions" && !items.data && error && <ErrorState message={error} onRetry={() => void reload()} />}
    {actions.error ? <Banner tone="red" title="Action needs attention" message={actions.error} /> : null}

    {section === "promises" && items.data && (promiseGroups.length === 0
      ? <Panel><EmptyState title="No open promises" message="Promises you make in analyzed meetings appear here with the words you used." /></Panel>
      : promiseGroups.map((group) => <Panel key={group.id} title={group.label} spec={PROMISE_GROUP[group.id]} count={group.items.length} padded={false}
        note={group.id === "looks_done" ? "DAVE's suggestion from later evidence. Nothing closes until you confirm." : undefined}>
        <Stack gap={0}>{group.items.map((item, i) => <Stack key={item.id} gap={0}>{i > 0 && <Divider />}
          <MeetingItemRow item={item} busy={actions.busyId === item.id} onAction={actions.onAction} onChanged={() => void reload()} showKind={false} /></Stack>)}</Stack>
      </Panel>))}
    {section === "promises" && items.data && promiseGroups.length > 0 &&
      <Button title="Clean up in bulk" variant="subtle" onPress={() => router.push("/cleanup?bucket=overdue_promises")} />}

    {section === "asks" && items.data && (items.data.asks.length === 0
      ? <Panel><EmptyState title="No open client asks" message="Suggestions and pain points your clients raise appear here, each pain point with a small feature idea." /></Panel>
      : <Panel title="Client asks" count={items.data.asks.length} padded={false}>
        <Stack gap={0}>{items.data.asks.map((item, i) => <Stack key={item.id} gap={0}>{i > 0 && <Divider />}
          <MeetingItemRow item={item} busy={actions.busyId === item.id} onAction={actions.onAction} onChanged={() => void reload()} /></Stack>)}</Stack>
      </Panel>)}

    {section === "list" && recordings.data && (recordings.data.meetings.length === 0
      ? <Panel><EmptyState title="No meetings imported yet" message={connected ? "DAVE checks Fathom every 5 minutes." : "Connect Fathom to start."} /></Panel>
      : <Panel title="Imported meetings" count={recordings.data.meetings.length} padded={false}>
        <Stack gap={0}>{recordings.data.meetings.map((m, i) => {
          const spec = MEETING_STATUS[m.status];
          const sub = [meetingWhen(m.startedAt ?? m.createdAt), m.projectName ?? "", MEETING_STATUS_LABELS[m.status],
            m.status === "analyzed" ? meetingCountsText(m) : "", m.staleInstructions ? "Analyzed with older instructions" : "", m.skipReason ?? m.error ?? ""].filter(Boolean).join(" · ");
          return <Stack key={m.recordingId} gap={0}>{i > 0 && <Divider />}
            <Row title={m.headline ?? m.title} subtitle={sub} spec={spec} onPress={() => router.push(`/meetings/${m.recordingId}`)} /></Stack>;
        })}</Stack>
      </Panel>)}

    {section === "instructions" && <InstructionsPanel state={state} onChanged={() => void reload()} />}
  </Screen>;
}
