import { useState } from "react";
import { ActionIcon, Button, Group, NativeSelect, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { Compass, Keyboard, Mic, Plus, Trash2, X } from "lucide-react";
import type { DirectionNote, ProjectIntel } from "../../../intel/types.ts";
import { DIRECTION_NOTE_MAX_CHARS, PRIORITY_MAX, PRIORITY_MIN } from "../../../intel/types.ts";
import { StatusMark } from "../../components/Status.tsx";
import { PanelHead } from "../../components/WorkspacePrimitives.tsx";
import { PRIORITY_LABEL, agoLabel, directionReasons, scoreReasonLabel } from "../../focus-model.ts";
import { intelApi } from "../../intel-api.ts";
import type { StatusSpec } from "../../status.ts";
import type { Run } from "./DeliveryPlan.tsx";

const DIRECTION: StatusSpec = { tone: "blue", icon: Compass, label: "Your direction" };
const NOTE_SOURCE: Readonly<Record<DirectionNote["source"], StatusSpec>> = {
  voice: { tone: "violet", icon: Mic, label: "Voice" },
  ui: { tone: "gray", icon: Keyboard, label: "Typed" },
};
const PRIORITIES = Array.from({ length: PRIORITY_MAX - PRIORITY_MIN + 1 }, (_, i) => PRIORITY_MIN + i);

/** What you told DAVE about this project. Every field here is yours and joins the ranking as a named reason. */
export function DirectionPanel({ data, busy, run, now }: { data: ProjectIntel; busy: string | null; run: Run; now: number }) {
  const d = data.direction;
  const id = data.projectId;
  const reasons = directionReasons(data.objective);
  return <section className="app-panel direction-panel" aria-labelledby="dir-h">
    <PanelHead id="dir-h" title="Your direction" spec={DIRECTION}
      note="What gets you paid, how this project ranks for you and what matters most now. DAVE ranks the work with it." />
    <Stack gap="md" className="direction-body">
      <PaidWhen key={`pw:${d.paidWhen ?? ""}`} value={d.paidWhen} busy={busy}
        onSave={(v) => run("dir:paid", () => intelApi.setDirection(id, { paidWhen: v }))} />
      <NativeSelect label="Priority" description="Your ranking of this project against the others" value={d.priority === null ? "" : String(d.priority)} disabled={!!busy}
        className="direction-priority"
        onChange={e => { const v = e.currentTarget.value; void run("dir:priority", () => intelApi.setDirection(id, { priority: v ? Number(v) : null })); }}
        data={[{ value: "", label: "None" }, ...PRIORITIES.map(p => ({ value: String(p), label: PRIORITY_LABEL[p] ?? String(p) }))]} />
      <FocusItems data={data} busy={busy} run={run} />
      {reasons.length > 0 && <div className="direction-effect" aria-label="How your direction changes the ranking">
        <Text size="sm" fw={600}>Effect on the next objective</Text>
        <ul className="plain-list">{reasons.map(r => <li key={r.code} className="row-sub"><span className="quiet-tag">{scoreReasonLabel(r.code)} · +{r.points}</span> <span>{r.detail}</span></li>)}</ul>
      </div>}
      <Notes projectId={id} notes={d.notes} busy={busy} run={run} now={now} />
    </Stack>
  </section>;
}

function PaidWhen({ value, busy, onSave }: { value: string | null; busy: string | null; onSave: (v: string | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return <div className="direction-field">
      <Text size="sm" fw={600} component="div">Paid when</Text>
      <Group gap="sm" wrap="wrap">
        <Text size="sm" c={value ? undefined : "dimmed"}>{value ?? "Not set. What has to happen before the client pays?"}</Text>
        <Button size="xs" variant="default" disabled={!!busy} onClick={() => { setDraft(value ?? ""); setEditing(true); }}>{value ? "Edit" : "Set"}</Button>
        {value && <Button size="xs" variant="subtle" color="gray" disabled={!!busy} loading={busy === "dir:paid"} onClick={() => void onSave(null)}>Clear</Button>}
      </Group>
    </div>;
  }
  const save = () => void onSave(draft.trim() || null).then(ok => { if (ok) setEditing(false); });
  return <div className="direction-field" data-intel-editing>
    <TextInput label="Paid when" description="For example: the client signs off the booking flow" value={draft} maxLength={DIRECTION_NOTE_MAX_CHARS} autoFocus
      onChange={e => setDraft(e.currentTarget.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
    <Group gap="xs" className="action-bar">
      <Button size="xs" disabled={!!busy || draft.trim() === (value ?? "")} loading={busy === "dir:paid"} onClick={save}>Save</Button>
      <Button size="xs" variant="default" disabled={busy === "dir:paid"} onClick={() => setEditing(false)}>Cancel</Button>
    </Group>
  </div>;
}

function FocusItems({ data, busy, run }: { data: ProjectIntel; busy: string | null; run: Run }) {
  const [pick, setPick] = useState("");
  const ids = data.direction.focusItemIds;
  const byId = new Map(data.items.map(i => [i.id, i]));
  const open = data.items.filter(i => (i.kind === "requirement" || i.kind === "milestone") && (i.status === "open" || i.status === "in_progress")
    && i.lane !== "extra" && i.lane !== "phase2" && !ids.includes(i.id));
  const save = (next: string[]) => run("dir:focus", () => intelApi.setDirection(data.projectId, { focusItemIds: next }));
  return <div className="direction-field" data-intel-editing={pick ? true : undefined}>
    <Text size="sm" fw={600} component="div" id="dir-focus-h">Matters most now</Text>
    {ids.length ? <ul className="direction-chips" aria-labelledby="dir-focus-h">{ids.map(fid => {
      const title = byId.get(fid)?.title ?? fid;
      return <li key={fid} className="direction-chip"><span>{title}</span>
        <ActionIcon variant="subtle" color="gray" size={44} aria-label={`Remove "${title}" from matters most now`} disabled={!!busy}
          onClick={() => void save(ids.filter(x => x !== fid))}><X size={14} aria-hidden="true" /></ActionIcon></li>;
    })}</ul> : <Text size="sm" c="dimmed">Nothing picked. DAVE ranks by dates, blockers and evidence alone.</Text>}
    {open.length > 0 && <Group gap="xs" align="flex-end" wrap="wrap">
      <NativeSelect label="Add a finish-line item" value={pick} disabled={!!busy} onChange={e => setPick(e.currentTarget.value)}
        data={[{ value: "", label: "Choose an item" }, ...open.map(i => ({ value: i.id, label: i.title }))]} />
      <Button variant="default" leftSection={<Plus size={14} aria-hidden="true" />} disabled={!pick || !!busy} loading={busy === "dir:focus"}
        onClick={() => void save([...ids, pick]).then(ok => { if (ok) setPick(""); })}>Add</Button>
    </Group>}
  </div>;
}

function Notes({ projectId, notes, busy, run, now }: { projectId: string; notes: readonly DirectionNote[]; busy: string | null; run: Run; now: number }) {
  const [text, setText] = useState("");
  const add = () => void run("dir:note", async () => (await intelApi.addNote(projectId, text.trim())).intel).then(ok => { if (ok) setText(""); });
  return <div className="direction-field">
    <Title order={3} size="h5" id="dir-notes-h">What you told DAVE</Title>
    {notes.length ? <ul className="plain-list direction-notes" aria-labelledby="dir-notes-h">{notes.map(n => <li key={n.id} className="direction-note">
      <div className="direction-note-text"><Text size="sm">{n.text}</Text>
        <Group gap="sm" className="row-sub"><span>{agoLabel(n.createdAt, now)}</span><StatusMark spec={NOTE_SOURCE[n.source]} size={14} /></Group></div>
      <ActionIcon variant="subtle" color="gray" size={44} aria-label="Delete this note" disabled={!!busy} loading={busy === `dir:del:${n.id}`}
        onClick={() => void run(`dir:del:${n.id}`, async () => { await intelApi.deleteNote(n.id); return intelApi.project(projectId); })}><Trash2 size={16} aria-hidden="true" /></ActionIcon>
    </li>)}</ul> : <Text size="sm" c="dimmed">No notes yet.</Text>}
    <Stack gap="xs" maw={720} data-intel-editing={text ? true : undefined}>
      <Textarea label="Add a note" value={text} onChange={e => setText(e.currentTarget.value)} autosize minRows={2} maxLength={DIRECTION_NOTE_MAX_CHARS}
        description={`${text.trim().length}/${DIRECTION_NOTE_MAX_CHARS}`} />
      <div><Button disabled={!text.trim() || !!busy} loading={busy === "dir:note"} onClick={add}>Save note</Button></div>
    </Stack>
  </div>;
}
