/** Port of src/ui/sections/ProjectCard.tsx: project notes (overview) and source details (context). */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { usePreventRemove } from "expo-router";
import { Eye, EyeOff, FolderX, Pencil, Pin, PinOff } from "lucide-react-native";
import type { PortfolioProject } from "../../../../src/shared/types.ts";
import { relative } from "../../../../src/ui/format.ts";
import { EvidenceList } from "../../ui/EvidenceList";
import { Body, Button, Caption, confirm, Disclosure, Inline, Muted, Small, Stack, TextField } from "../../ui/primitives";
import { StatusIcon, StatusMark } from "../../ui/status";
import { space } from "../../ui/theme";
import { EditedBadge, PinnedBadge, TechnicalActivityBadge } from "./Labels";
import { activityLine, editLabel, NOTE_MAX, NOTES, noteLabel, noteSpec, validTime, type NoteKey } from "./model";
import type { SaveResult } from "./useProjectActions";

type Props = {
  project: PortfolioProject; busy: boolean;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: NoteKey, value: string) => Promise<SaveResult>;
};

/** useDraftGuard on the phone: leaving the screen with an open draft asks first. */
function useLeaveGuard(dirty: boolean, discard: () => void) {
  const disable = usePreventRemove(dirty, ({ repeat }) => {
    void confirm({ title: "Discard unsaved changes?", message: "Cancel keeps your draft.", confirmLabel: "Discard", cancelLabel: "Cancel", destructive: true })
      .then((ok) => { if (!ok) return; discard(); disable(); repeat(); });
  });
}

function Flags({ project: p }: { project: PortfolioProject }) {
  return <Inline>
    {p.override.pinned && <PinnedBadge />}
    {p.summary.edited && <EditedBadge />}
    {!p.exists && <StatusMark spec={{ tone: "red", icon: FolderX, label: "Folder missing" }}>Folder missing — the directory was not found on disk</StatusMark>}
  </Inline>;
}

/** Pin / hide controls (the web's options menu). */
export function ProjectOptions({ project: p, busy, onOverride }: Omit<Props, "onCorrect">) {
  return <Inline>
    <Button compact title={p.override.pinned ? "Unpin" : "Pin to Active"} icon={p.override.pinned ? PinOff : Pin} loading={busy} disabled={busy}
      accessibilityLabel={`${p.override.pinned ? "Unpin" : "Pin to Active"}: ${p.name}`} onPress={() => onOverride(p.id, { pinned: !p.override.pinned })} />
    <Button compact title={p.override.hidden ? "Unhide" : "Hide"} icon={p.override.hidden ? Eye : EyeOff} disabled={busy}
      accessibilityLabel={`${p.override.hidden ? "Unhide" : "Hide"}: ${p.name}`} onPress={() => onOverride(p.id, { hidden: !p.override.hidden })} />
  </Inline>;
}

export function ProjectNotes({ project: p, busy, onCorrect }: Props) {
  const s = p.summary;
  const [editing, setEditing] = useState<NoteKey | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useLeaveGuard(editing !== null, () => { setEditing(null); setDraft(""); });

  const save = async (key: NoteKey) => {
    if (saving) return;
    setSaving(true); setSaveError(null);
    const result = await onCorrect(p.id, key, draft);
    setSaving(false);
    if (result.ok) { setEditing(null); setDraft(""); }
    else setSaveError(`Not saved: ${result.error}. Your draft is retained; retry Save.`);
  };

  return <Stack>
    <Flags project={p} />
    {NOTES.map(({ key, label }) => {
      const value = s[key];
      const action = key === "suggestedNextAction";
      const control = editLabel(key, label);
      return <View key={key} style={styles.note}>
        <View style={styles.noteHead}>
          <StatusIcon spec={noteSpec(key, value)} />
          <View style={styles.flex}><Small strong>{noteLabel(key, label, s)}</Small></View>
          {editing !== key && <Button compact variant="subtle" title="Edit" icon={Pencil} disabled={editing !== null || busy}
            accessibilityLabel={action ? control : `${control}: ${value ?? "Not provided"}`}
            onPress={() => { setEditing(key); setDraft(value ?? ""); setSaveError(null); }} />}
        </View>
        {editing === key ? <Stack gap={space.sm}>
          <TextField label={control} value={draft} onChangeText={setDraft} multiline maxLength={NOTE_MAX} autoFocus editable={!saving && !busy}
            help={`${draft.length}/${NOTE_MAX} characters`} error={saveError} />
          <Inline>
            <Button title="Save" variant="primary" loading={saving} disabled={busy} onPress={() => void save(key)} />
            <Button title="Cancel" disabled={saving || busy} onPress={() => { setEditing(null); setDraft(""); setSaveError(null); }} />
          </Inline>
        </Stack> : value ? <Body strong={action} selectable>{value}</Body> : <Muted>Not provided</Muted>}
      </View>;
    })}
    {validTime(s.nextActionEditedAt) && <Caption>Action saved {relative(s.nextActionEditedAt)}</Caption>}
  </Stack>;
}

export function ProjectSources({ project: p }: { project: PortfolioProject }) {
  const s = p.summary;
  return <Stack>
    <Flags project={p} />
    <Small selectable>{p.canonicalPath}</Small>
    <Muted selectable>{activityLine(p)}</Muted>
    <TechnicalActivityBadge detail={p.relevance.reasons.map((r) => r.detail).join(" · ")} />
    {s.evidence.length > 0 && <Disclosure title={`Evidence (${s.evidence.length})`}><EvidenceList evidence={s.evidence} /></Disclosure>}
  </Stack>;
}

const styles = StyleSheet.create({
  note: { gap: space.xs },
  noteHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
});
