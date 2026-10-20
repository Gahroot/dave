import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Bot, Check, CircleSlash, ExternalLink, Pencil, RotateCcw, Undo2 } from "lucide-react-native";
import type { MeetingItem } from "../../../../src/meetings/types.ts";
import { ITEM_KIND_LABELS, ITEM_STATUS_LABELS, timestamp } from "../../../../src/ui/meetings-model.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Disclosure, Inline, Row, SelectField, Stack, TextField } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { colors, radius, space, text } from "../../ui/theme";
import { day, dueText, editProblem, itemChoices, leadSpec, showStatusNote, type ItemAction } from "./model";

const ACTION_ICON = { done: Check, dropped: CircleSlash, open: RotateCcw, confirm: Check, not_yet: Undo2 } as const;

/**
 * One promise, client ask or decision: the words that were said, where, and the
 * owner's options. DAVE never closes anything here without a tap.
 */
export function MeetingItemRow({ item, busy, onAction, onChanged, showProject = true, showMeeting = true, showKind = true, flag = "" }: {
  item: MeetingItem; busy: boolean; onAction: (item: MeetingItem, action: ItemAction) => void;
  /** Called after an edit saved, to reload the list. */
  onChanged: () => void;
  showProject?: boolean; showMeeting?: boolean; showKind?: boolean; flag?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const spec = leadSpec(item, new Date());
  const { draft, actions } = itemChoices(item);
  const kindLabel = showKind ? ITEM_KIND_LABELS[item.kind] : "";
  const statusLabel = item.status !== "open" ? ITEM_STATUS_LABELS[item.status] : "";
  const due = dueText(item);
  const meta = [due, showProject ? item.projectName ?? "No project" : "", showMeeting ? `${item.meetingTitle}, ${day(item.meetingAt)}` : ""].filter(Boolean).join(" · ");
  const meetingUrl = item.meetingUrl;
  return <Row title={item.text} spec={spec}>
    <Stack gap={space.sm}>
      <Inline>
        {flag ? <Text style={[text.small, styles.bold]}>{flag}</Text> : null}
        {(kindLabel || statusLabel) ? <StatusMark spec={spec}>{[kindLabel, statusLabel].filter(Boolean).join(" · ")}</StatusMark> : null}
        {item.edited ? <Text style={text.caption}>Edited</Text> : null}
      </Inline>
      {meta ? <Text style={text.muted}>{meta}</Text> : null}
      <View style={styles.quote}>
        <Text style={text.caption}>{item.speaker} · {timestamp(item.atSeconds)}</Text>
        <Text style={text.small} selectable>“{item.quote}”</Text>
        {meetingUrl && <Button title="Open in Fathom" icon={ExternalLink} variant="subtle" compact onPress={() => void Linking.openURL(meetingUrl)} />}
      </View>
      {item.feature && <Disclosure title={`Idea: ${item.feature.title}`}>
        <Text style={text.small} selectable>{item.feature.outcome}</Text>
        {item.feature.acceptance.map((check) => <Text key={check} style={text.small} selectable>• {check}</Text>)}
      </Disclosure>}
      {showStatusNote(item) && <Text style={text.muted} selectable>{item.statusNote}</Text>}
      {item.status === "planned" && item.agentRunId && <Inline><Button title="View agent run" icon={Bot} compact onPress={() => router.push(`/agents/${item.agentRunId}`)} /></Inline>}
      {(draft || actions.length > 0) && <Inline>
        {draft && <Button title="Draft agent assignment" icon={Bot} compact onPress={() => router.push(`/agents/new?meetingItem=${encodeURIComponent(item.id)}`)} />}
        {actions.map((a) => <Button key={a.action} title={a.label} icon={ACTION_ICON[a.action]} variant={a.variant} compact disabled={busy}
          accessibilityLabel={`${a.label}: ${item.text}`} onPress={() => onAction(item, a.action)} />)}
      </Inline>}
      {!editing && item.status !== "done" && item.status !== "dropped" && <Inline><Button title="Edit" icon={Pencil} variant="subtle" compact disabled={busy} accessibilityLabel={`Edit: ${item.text}`} onPress={() => setEditing(true)} /></Inline>}
      {editing && <EditItem item={item} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
    </Stack>
  </Row>;
}

/** Correct DAVE's reading: the wording, due date or project. Never changes status. */
function EditItem({ item, onClose, onSaved }: { item: MeetingItem; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const choices = useResource<{ projects: { id: string; name: string }[] }>("/api/meetings/projects");
  const [value, setValue] = useState(item.text);
  const [dueDate, setDueDate] = useState(item.dueDate ?? "");
  const [project, setProject] = useState(item.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = editProblem(value, dueDate);
  const save = async () => {
    if (busy || problem) return;
    setBusy(true); setError("");
    const body: { text?: string; dueDate?: string | null; projectId?: string | null } = {};
    if (value.trim() !== item.text) body.text = value.trim();
    if ((dueDate.trim() || null) !== item.dueDate) body.dueDate = dueDate.trim() || null;
    if ((project || null) !== item.projectId) body.projectId = project || null;
    try { await api.post(`/api/meetings/items/${encodeURIComponent(item.id)}/edit`, body); onSaved(); }
    catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  };
  const options = [{ value: "", label: "No project" }, ...(choices.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))];
  return <View style={styles.edit}>
    <TextField label="What was said" value={value} onChangeText={setValue} multiline editable={!busy} maxLength={700} />
    {item.kind === "commitment" && <TextField label="Due date" help="YYYY-MM-DD, or empty for no date" value={dueDate} onChangeText={setDueDate} editable={!busy} autoCapitalize="none" autoCorrect={false} />}
    <SelectField label="Project" value={project} options={options} onChange={setProject} disabled={busy || !choices.data} />
    {choices.error && <Banner tone="red" title="Projects unavailable" message={choices.error} />}
    {(problem || error) && <Banner tone="red" title="Edit needs attention" message={error || problem || ""} />}
    <Inline>
      <Button title="Cancel" compact onPress={onClose} disabled={busy} />
      <Button title="Save changes" variant="primary" compact loading={busy} disabled={!!problem} onPress={() => void save()} />
    </Inline>
  </View>;
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm, gap: space.xxs },
  edit: { gap: space.sm, backgroundColor: colors.sunken, borderRadius: radius.md, padding: space.sm },
});
