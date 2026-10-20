/**
 * Paste an agreement, tick what belongs on the finish line, add it. Parsing runs on this phone
 * (the shared pure parser): the pasted text is never sent anywhere, only the lines you tick.
 */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Plus, Search, Square, SquareCheck } from "lucide-react-native";
import { AGREEMENT_MAX_CHARS, parseAgreement } from "../../../../src/intel/agreement.ts";
import { Button, Caption, Inline, Muted, Small, Stack, TextField } from "../../ui/primitives";
import { colors, radius, space, text, touch } from "../../ui/theme";
import type { IntelApi } from "./api";
import type { Run } from "./DeliveryPlan";
import { acceptancePreview } from "./model";
import { FeedbackLine } from "./parts";
import { useEditing } from "./useIntelResource";

type Candidate = { key: string; title: string; detail: string | null; section: string | null; picked: boolean };
const MAX_TITLE = 300;
const MAX_DETAIL = 2000;

function Check({ checked, label, onChange, disabled = false, children }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  const Icon = checked ? SquareCheck : Square;
  return <Pressable onPress={() => onChange(!checked)} disabled={disabled} accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked, disabled }} style={[styles.check, disabled && styles.disabled]}>
    <Icon size={22} color={checked ? colors.accent : colors.control} />
    {children}
  </Pressable>;
}

export function AgreementImport({ projectId, confirmed, busy, run, intel }: { projectId: string; confirmed: boolean; busy: string | null; run: Run; intel: IntelApi }) {
  const [draft, setDraft] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [acceptance, setAcceptance] = useState<string[]>([]);
  const [withAcceptance, setWithAcceptance] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const picked = (found ?? []).filter(c => c.picked && c.title.trim());
  useEditing(!!draft || !!found);

  const find = () => {
    const parsed = parseAgreement(draft);
    setFound(parsed.items.map((it, i) => ({ key: `${i}:${it.title}`, ...it, picked: true })));
    setAcceptance(parsed.acceptance);
    setResult(null);
  };
  const update = (key: string, change: Partial<Candidate>) => setFound(list => list?.map(c => c.key === key ? { ...c, ...change } : c) ?? null);
  const add = () => void run("agreement", async () => {
    const items = picked.map(c => ({ title: c.title.trim().slice(0, MAX_TITLE), ...(c.detail ? { detail: c.detail.slice(0, MAX_DETAIL) } : {}) }));
    const r = await intel.addFinishLine(projectId, items, confirmed && withAcceptance ? acceptance : undefined);
    setResult(`Added ${r.added} to the finish line.${r.skipped ? ` Skipped ${r.skipped} already there.` : ""}`);
    return r.intel;
  }).then(ok => { if (ok) { setDraft(""); setFound(null); setAcceptance([]); } });

  return <Stack gap={space.sm}>
    <Text style={text.subheading} accessibilityRole="header">Add from your agreement</Text>
    <TextField label="Paste the agreement, statement of work or proposal" help="Read here on your phone. Only the lines you tick are saved."
      value={draft} onChangeText={v => { setDraft(v); setFound(null); }} maxLength={AGREEMENT_MAX_CHARS} multiline style={styles.paste} />
    <Button title="Find deliverables" icon={Search} compact style={styles.start} disabled={!draft.trim() || !!busy} onPress={find} />
    {result && <FeedbackLine tone="green" message={result} />}
    {found && !found.length && <Muted>No deliverables found. Bulleted or numbered lists under headings like Deliverables or Scope work best.</Muted>}
    {found && found.length > 0 && <Stack gap={space.sm}>
      <Small strong>Found {found.length}. Untick anything that is not part of the job.</Small>
      <Inline>
        <Button title="Tick all" variant="subtle" compact onPress={() => setFound(l => l?.map(c => ({ ...c, picked: true })) ?? null)} />
        <Button title="Untick all" variant="subtle" compact onPress={() => setFound(l => l?.map(c => ({ ...c, picked: false })) ?? null)} />
      </Inline>
      {found.map((c, i) => <View key={c.key} style={styles.candidate}>
        <Check checked={c.picked} label={`Add deliverable ${i + 1}`} onChange={picked => update(c.key, { picked })} />
        <View style={styles.flex}>
          <TextInput accessibilityLabel={`Deliverable ${i + 1} title`} value={c.title} maxLength={MAX_TITLE} editable={c.picked}
            onChangeText={title => update(c.key, { title })} style={[styles.input, !c.picked && styles.disabled]} multiline />
          {(c.section || c.detail) && <Caption>{[c.section, c.detail].filter(Boolean).join(" · ")}</Caption>}
        </View>
      </View>)}
      {acceptance.length > 0 && <Check checked={confirmed && withAcceptance} disabled={!confirmed} onChange={setWithAcceptance}
        label={`Also add ${acceptance.length} acceptance ${acceptance.length === 1 ? "line" : "lines"} to the finish line`}>
        <View style={styles.flex}>
          <Small>Also add {acceptance.length} acceptance {acceptance.length === 1 ? "line" : "lines"} to the finish line</Small>
          <Caption>{confirmed ? acceptancePreview(acceptance) : "Confirm the finish line first to add acceptance lines."}</Caption>
        </View>
      </Check>}
      <Button title={picked.length ? `Add ${picked.length} to the finish line` : "Tick at least one"} icon={Plus} variant="primary" style={styles.start}
        disabled={!picked.length || (!!busy && busy !== "agreement")} loading={busy === "agreement"} onPress={add} />
    </Stack>}
  </Stack>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0, gap: space.xxs },
  start: { alignSelf: "flex-start" },
  paste: { maxHeight: 260 },
  check: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch, minWidth: touch },
  candidate: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  input: { minHeight: 36, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: space.xs, fontSize: 15, color: colors.ink },
  disabled: { opacity: 0.45 },
});
