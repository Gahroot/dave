/**
 * "From meetings" on the project workspace (mirrors src/ui/sections/ProjectMeetings.tsx):
 * what was promised, what the client asked for, and what happened since the
 * last call. Renders nothing when the project has no meetings; never calls the model.
 * Embedded inside the workspace ScrollView, so it returns Panels only.
 */
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { ArrowRight, CircleCheck, Handshake, MessageSquareWarning, TriangleAlert } from "lucide-react-native";
import type { MeetingItem, ProjectMeetingsOverview } from "../../../../src/meetings/types.ts";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Disclosure, Divider, Inline, Panel, Small, Stack } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";
import { text } from "../../ui/theme";
import { MeetingItemRow } from "./MeetingItemRow";
import { day, EVIDENCE_LABEL, projectGroups, STATE_NOTE } from "./model";
import { useItemAction } from "./useItemAction";

const FROM_MEETINGS: StatusSpec = { tone: "blue", icon: Handshake, label: "From meetings" };

export function ProjectMeetingsPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const overview = useResource<ProjectMeetingsOverview>(`/api/meetings/projects/${encodeURIComponent(projectId)}`);
  const actions = useItemAction(overview.reload);
  const data = overview.data;

  if (overview.error && !data) return <Panel title="From meetings" spec={FROM_MEETINGS}><Banner tone="red" title="Meeting context unavailable" message={overview.error} action={<Button title="Retry" compact onPress={() => void overview.reload()} />} /></Panel>;
  if (!data || (data.items.length === 0 && !data.lastCall)) return null;

  const g = projectGroups(data);
  const list = (items: MeetingItem[]) => <Stack gap={0}>{items.map((item, i) => <Stack key={item.id} gap={0}>{i > 0 && <Divider />}
    <MeetingItemRow item={item} busy={actions.busyId === item.id} onAction={actions.onAction} onChanged={() => void overview.reload()} showProject={false}
      showKind={item.kind !== "commitment"} flag={item.kind === "commitment" && item.status === "open" ? STATE_NOTE[g.state(item)] : ""} /></Stack>)}</Stack>;
  const group = (title: string, items: MeetingItem[], spec: StatusSpec) => items.length > 0 && <Disclosure title={title} count={items.length} spec={spec} defaultOpen>{list(items)}</Disclosure>;
  const lastCall = data.lastCall;

  return <Panel title="From meetings" spec={FROM_MEETINGS}
    actions={<Button title="All meetings" icon={ArrowRight} variant="subtle" compact onPress={() => router.push("/meetings")} />}>
    {actions.error ? <Banner tone="red" title="Action needs attention" message={actions.error} /> : null}
    {lastCall && <Stack gap={4}>
      <Inline>
        <Small>Last call:</Small>
        <Button title={lastCall.title} variant="subtle" compact accessibilityHint="Opens the meeting" onPress={() => router.push(`/meetings/${lastCall.recordingId}`)} />
        <Small>{day(lastCall.at)}</Small>
      </Inline>
      {lastCall.headline ? <Text style={text.small} selectable>{lastCall.headline}</Text> : null}
      {lastCall.direction.map((d) => <Text key={d} style={text.small} selectable>• {d}</Text>)}
    </Stack>}
    {lastCall && <Disclosure title={`Since your last call (${data.sinceLastCall.length})`}>
      {data.sinceLastCall.length === 0 ? <Small>No commits, accepted agent runs, finished milestones or done tasks since that call.</Small>
        : data.sinceLastCall.map((e) => <Text key={e.id} style={text.small} selectable>• {EVIDENCE_LABEL[e.kind]}, {day(e.at)}: {e.title}</Text>)}
    </Disclosure>}
    {group("Overlooked", g.overlooked, { tone: "red", icon: TriangleAlert, label: "" })}
    {group("Promised", g.open, { tone: "blue", icon: Handshake, label: "" })}
    {group("Client asks", g.asks, { tone: "violet", icon: MessageSquareWarning, label: "" })}
    {g.done.length > 0 && <Disclosure title={`Done (${g.done.length})`} spec={{ tone: "green", icon: CircleCheck, label: "" }}>{list(g.done)}</Disclosure>}
    {!lastCall && g.overlooked.length + g.open.length + g.asks.length + g.done.length === 0 && <StatusMark spec={FROM_MEETINGS}>Nothing open from meetings.</StatusMark>}
  </Panel>;
}
