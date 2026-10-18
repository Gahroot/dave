/** Phone ports of InboxView (attention cards), NextBestAction and RoadmapPanel. */
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { AlarmClock, ArrowRight, Check, CircleSlash, ExternalLink, Undo2 } from "lucide-react-native";
import type { AttentionAction, InboxItem, Portfolio } from "../../../../src/shared/types.ts";
import type { Roadmap } from "../../../../src/model/roadmap.ts";
import type { TopAction } from "../../../../src/ui/top-action.ts";
import { inboxKindLabel } from "../../../../src/ui/inbox-model.ts";
import { INBOX_KIND } from "../../../../src/ui/status.ts";
import { handoff, relative } from "../../../../src/ui/format.ts";
import { findProject } from "../../lib/portfolio";
import { Body, Button, Caption, CopyButton, Disclosure, Inline, Muted, Panel, Small, Stack } from "../../ui/primitives";
import { StatusMark, StatusTile } from "../../ui/status";
import { EvidenceList } from "../../ui/EvidenceList";
import { text } from "../../ui/theme";
import { CLEAR, HISTORY_STATE, ROADMAP, YOUR_MOVE, deliveryTarget, historyLabel, historyState, meetingsTarget, roadmapGapText, roadmapSummary, topActionReason } from "./model";

export function AttentionCard({ item, portfolio, busyId, history = false, compact = false, onResolve }: {
  item: InboxItem; portfolio: Portfolio; busyId: string | null; history?: boolean; compact?: boolean;
  onResolve: (id: string, action: AttentionAction) => void;
}) {
  const router = useRouter();
  const kind = INBOX_KIND[item.kind];
  const project = findProject(portfolio, item.projectId);
  const meetings = meetingsTarget(item);
  const busy = !!busyId;
  return <Stack gap={10}>
    <Stack gap={4}>
      <StatusMark spec={kind} strong>{inboxKindLabel(item.kind)}</StatusMark>
      {history && <StatusMark spec={HISTORY_STATE[historyState(item)]}>{historyLabel(item)}</StatusMark>}
    </Stack>
    {!compact && <Body strong selectable>{item.title}</Body>}
    {!!item.detail && <Small selectable>{item.detail}</Small>}
    {!!item.nextStep && <Small selectable><Text style={styles.bold}>Next </Text>{item.nextStep}</Small>}
    <Inline>
      {history
        ? <Button title="Undo" icon={Undo2} disabled={busy} loading={busyId === item.id} onPress={() => onResolve(item.id, "undo")} />
        : <>
          <Button title="Handled" variant="primary" icon={Check} disabled={busy} loading={busyId === item.id} onPress={() => onResolve(item.id, "handled")} />
          <Button title="Tomorrow" icon={AlarmClock} disabled={busy} onPress={() => onResolve(item.id, "tomorrow")} />
          <Button title="Not relevant" variant="subtle" icon={CircleSlash} disabled={busy} onPress={() => onResolve(item.id, "dismiss")} />
        </>}
    </Inline>
    {!history && <Caption>Handled remembers this evidence locally. It does not complete upstream work.</Caption>}
    {project ? <Inline>
      <Button title="View project" icon={ExternalLink} compact onPress={() => router.push(`/project/${project.id}`)} />
      {meetings && <Button title="Open in Meetings" icon={ExternalLink} compact onPress={() => router.push(meetings)} />}
      <CopyButton text={project.canonicalPath} label="Copy path" />
      <CopyButton text={handoff(project, item)} label="Copy handoff" />
    </Inline> : <Small>Project context unavailable; retained evidence may be stale.</Small>}
    <Caption>Source {relative(item.evidence[0]?.observedAt ?? null)} · Last observed {relative(item.lastObservedAt)}</Caption>
    <Disclosure title={`Evidence (${item.evidence.length})`}><EvidenceList evidence={item.evidence} /></Disclosure>
  </Stack>;
}

export function NextBestAction({ action, onOpen }: { action: TopAction | null; onOpen: (action: TopAction) => void }) {
  if (!action) return <Panel>
    <View style={styles.top}><StatusTile spec={CLEAR} /><View style={styles.flex}>
      <Body strong>Nothing needs you right now</Body>
      <Muted>Everything loaded is waiting on someone else or already handled.</Muted>
    </View></View>
  </Panel>;
  return <Panel tone="amber">
    <View style={styles.top}>
      <StatusTile spec={YOUR_MOVE} />
      <View style={[styles.flex, styles.gap]}>
        <Text style={text.caption} accessibilityRole="header">Do this next · {action.project}</Text>
        <Text style={text.subheading} selectable>{action.title}</Text>
        <Small><Text style={styles.bold}>Why it matters:</Text> {action.impact}{topActionReason(action)}</Small>
        <Small><Text style={styles.bold}>Finished when:</Text> {action.done}</Small>
      </View>
    </View>
    <Button title="Open it" variant="primary" icon={ArrowRight} onPress={() => onOpen(action)} />
    {!!action.alsoNext.length && <Caption>Then: {action.alsoNext.join(" · ")}</Caption>}
  </Panel>;
}

export function RoadmapPanel({ roadmaps }: { roadmaps: readonly Roadmap[] }) {
  const router = useRouter();
  if (!roadmaps.length) return null;
  return <Panel title="Roadmaps" spec={ROADMAP} count={roadmaps.length} note="Active projects, measured against what delivered means.">
    {roadmaps.map((r) => {
      const gap = roadmapGapText(r);
      return <Stack key={r.projectId} gap={4}>
        <Button title={r.projectName} variant="subtle" compact style={styles.start} onPress={() => router.push(deliveryTarget(r.projectId))} />
        <Small>{roadmapSummary(r)}</Small>
        {!!r.finish && <Caption>Delivered means: {r.finish}</Caption>}
        {gap && <>
          <Small>{gap}</Small>
          <Button title="Review the plan and replan" variant="subtle" compact style={styles.start} onPress={() => router.push(deliveryTarget(r.projectId))} />
        </>}
      </Stack>;
    })}
  </Panel>;
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  top: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  flex: { flex: 1, minWidth: 0 },
  gap: { gap: 4 },
  start: { alignSelf: "flex-start", paddingHorizontal: 0 },
});
