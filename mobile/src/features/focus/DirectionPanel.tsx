/** Native port of src/ui/sections/focus/DirectionPanel.tsx: what you told DAVE about this project. Every field joins the ranking as a named reason. */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Compass, Keyboard, Mic, Plus, Trash2, X } from "lucide-react-native";
import type { DirectionNote, ProjectIntel } from "../../../../src/intel/types.ts";
import { DIRECTION_NOTE_MAX_CHARS, PRIORITY_MAX, PRIORITY_MIN } from "../../../../src/intel/types.ts";
import { PRIORITY_LABEL, agoLabel, directionReasons, scoreReasonLabel } from "../../../../src/ui/focus-model.ts";
import { Body, Button, Caption, Divider, Heading, IconButton, Inline, Muted, Panel, SelectField, Small, Stack, Tag, TextField, confirm } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";
import { colors, space } from "../../ui/theme";
import type { IntelApi } from "./api";
import type { Run } from "./DeliveryPlan";

const DIRECTION: StatusSpec = { tone: "blue", icon: Compass, label: "Your direction" };
const NOTE_SOURCE: Readonly<Record<DirectionNote["source"], StatusSpec>> = {
  voice: { tone: "violet", icon: Mic, label: "Voice" },
  ui: { tone: "gray", icon: Keyboard, label: "Typed" },
};
const PRIORITIES = Array.from({ length: PRIORITY_MAX - PRIORITY_MIN + 1 }, (_, i) => PRIORITY_MIN + i);
const NONE = "none";

export function DirectionPanel({ data, busy, run, now, intel }: { data: ProjectIntel; busy: string | null; run: Run; now: number; intel: IntelApi }) {
  const d = data.direction;
  const id = data.projectId;
  const reasons = directionReasons(data.objective);
  return <Panel title="Your direction" spec={DIRECTION}
    note="What gets you paid, how this project ranks for you and what matters most now. DAVE ranks the work with it.">
    <PaidWhen key={`pw:${d.paidWhen ?? ""}`} value={d.paidWhen} busy={busy}
      onSave={(v) => run("dir:paid", () => intel.setDirection(id, { paidWhen: v }))} />
    <SelectField label="Priority" help="Your ranking of this project against the others" disabled={!!busy}
      value={d.priority === null ? NONE : String(d.priority)}
      options={[{ value: NONE, label: "None" }, ...PRIORITIES.map((p) => ({ value: String(p), label: PRIORITY_LABEL[p] ?? String(p) }))]}
      onChange={(v) => { void run("dir:priority", () => intel.setDirection(id, { priority: v === NONE ? null : Number(v) })); }} />
    <FocusItems data={data} busy={busy} run={run} intel={intel} />
    {reasons.length > 0 && <Stack gap={space.xs}>
      <Small strong>Effect on the next objective</Small>
      {reasons.map((r) => <Inline key={r.code}><Tag>{`${scoreReasonLabel(r.code)} · +${r.points}`}</Tag><Caption>{r.detail}</Caption></Inline>)}
    </Stack>}
    <Divider />
    <Notes projectId={id} notes={d.notes} busy={busy} run={run} now={now} intel={intel} />
  </Panel>;
}

function PaidWhen({ value, busy, onSave }: { value: string | null; busy: string | null; onSave: (v: string | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return <Stack gap={space.xs}>
      <Small strong>Paid when</Small>
      {value ? <Body selectable>{value}</Body> : <Muted>Not set. What has to happen before the client pays?</Muted>}
      <Inline>
        <Button title={value ? "Edit" : "Set"} compact disabled={!!busy} onPress={() => { setDraft(value ?? ""); setEditing(true); }}
          accessibilityLabel={value ? "Edit paid when" : "Set paid when"} />
        {value && <Button title="Clear" variant="subtle" compact disabled={!!busy} loading={busy === "dir:paid"} onPress={() => void onSave(null)}
          accessibilityLabel="Clear paid when" />}
      </Inline>
    </Stack>;
  }
  const save = () => void onSave(draft.trim() || null).then((ok) => { if (ok) setEditing(false); });
  return <Stack gap={space.xs}>
    <TextField label="Paid when" help="For example: the client signs off the booking flow" value={draft} maxLength={DIRECTION_NOTE_MAX_CHARS} autoFocus
      onChangeText={setDraft} onSubmitEditing={save} returnKeyType="done" />
    <Inline>
      <Button title="Save" variant="primary" compact disabled={!!busy || draft.trim() === (value ?? "")} loading={busy === "dir:paid"} onPress={save} />
      <Button title="Cancel" compact disabled={busy === "dir:paid"} onPress={() => setEditing(false)} />
    </Inline>
  </Stack>;
}

function FocusItems({ data, busy, run, intel }: { data: ProjectIntel; busy: string | null; run: Run; intel: IntelApi }) {
  const [pick, setPick] = useState<string | null>(null);
  const ids = data.direction.focusItemIds;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const open = data.items.filter((i) => (i.kind === "requirement" || i.kind === "milestone") && (i.status === "open" || i.status === "in_progress")
    && i.lane !== "extra" && i.lane !== "phase2" && !ids.includes(i.id));
  const save = (next: string[]) => run("dir:focus", () => intel.setDirection(data.projectId, { focusItemIds: next }));
  return <Stack gap={space.xs}>
    <Small strong>Matters most now</Small>
    {ids.length ? ids.map((fid) => {
      const title = byId.get(fid)?.title ?? fid;
      return <View key={fid} style={styles.chip}>
        <View style={styles.flex}><Body>{title}</Body></View>
        <IconButton icon={X} label={`Remove "${title}" from matters most now`} disabled={!!busy} onPress={() => void save(ids.filter((x) => x !== fid))} />
      </View>;
    }) : <Muted>Nothing picked. DAVE ranks by dates, blockers and evidence alone.</Muted>}
    {open.length > 0 && <>
      <SelectField label="Add a finish-line item" placeholder="Choose an item" value={pick} disabled={!!busy} onChange={setPick}
        options={open.map((i) => ({ value: i.id, label: i.title }))} />
      <Inline><Button title="Add" icon={Plus} compact disabled={!pick || !!busy} loading={busy === "dir:focus"}
        onPress={() => { if (pick) void save([...ids, pick]).then((ok) => { if (ok) setPick(null); }); }} /></Inline>
    </>}
  </Stack>;
}

function Notes({ projectId, notes, busy, run, now, intel }: { projectId: string; notes: readonly DirectionNote[]; busy: string | null; run: Run; now: number; intel: IntelApi }) {
  const [text, setText] = useState("");
  const add = () => void run("dir:note", async () => (await intel.addNote(projectId, text.trim())).intel).then((ok) => { if (ok) setText(""); });
  const remove = async (n: DirectionNote) => {
    if (!(await confirm({ title: "Delete this note?", message: "DAVE stops using it when ranking this project.", confirmLabel: "Delete", destructive: true }))) return;
    void run(`dir:del:${n.id}`, async () => { await intel.deleteNote(n.id); return intel.project(projectId); });
  };
  return <Stack gap={space.sm}>
    <Heading>What you told DAVE</Heading>
    {notes.length ? notes.map((n) => <View key={n.id} style={styles.chip}>
      <View style={styles.flex}><Stack gap={space.xxs}>
        <Body selectable>{n.text}</Body>
        <Inline><Caption>{agoLabel(n.createdAt, now)}</Caption><StatusMark spec={NOTE_SOURCE[n.source]} size={14} /></Inline>
      </Stack></View>
      <IconButton icon={Trash2} label="Delete this note" color={colors.danger} disabled={!!busy} onPress={() => void remove(n)} />
    </View>) : <Muted>No notes yet.</Muted>}
    <TextField label="Add a note" value={text} onChangeText={setText} multiline maxLength={DIRECTION_NOTE_MAX_CHARS}
      help={`${text.trim().length}/${DIRECTION_NOTE_MAX_CHARS}`} />
    <Inline><Button title="Save note" variant="primary" compact disabled={!text.trim() || !!busy} loading={busy === "dir:note"} onPress={add} /></Inline>
  </Stack>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  chip: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
