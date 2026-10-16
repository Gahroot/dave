import { useState } from "react";
import { Button, Checkbox, Group, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { Plus, Search } from "lucide-react";
import { AGREEMENT_MAX_CHARS, parseAgreement } from "../../../intel/agreement.ts";
import { intelApi } from "../../intel-api.ts";
import type { Run } from "./DeliveryPlan.tsx";

type Candidate = { key: string; title: string; detail: string | null; section: string | null; picked: boolean };
const MAX_TITLE = 300;
const MAX_DETAIL = 2000;

/**
 * Paste an agreement, tick what belongs on the finish line, add it. Parsing runs in this browser tab:
 * the pasted text is never sent anywhere, only the lines you tick.
 */
export function AgreementImport({ projectId, confirmed, busy, run }: { projectId: string; confirmed: boolean; busy: string | null; run: Run }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [acceptance, setAcceptance] = useState<string[]>([]);
  const [withAcceptance, setWithAcceptance] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const picked = (found ?? []).filter(c => c.picked && c.title.trim());
  const editing = !!text || !!found;

  const find = () => {
    const parsed = parseAgreement(text);
    setFound(parsed.items.map((it, i) => ({ key: `${i}:${it.title}`, ...it, picked: true })));
    setAcceptance(parsed.acceptance);
    setResult(null);
  };
  const update = (key: string, change: Partial<Candidate>) => setFound(list => list?.map(c => c.key === key ? { ...c, ...change } : c) ?? null);
  const add = () => void run("agreement", async () => {
    const items = picked.map(c => ({ title: c.title.trim().slice(0, MAX_TITLE), ...(c.detail ? { detail: c.detail.slice(0, MAX_DETAIL) } : {}) }));
    const r = await intelApi.addFinishLine(projectId, items, confirmed && withAcceptance ? acceptance : undefined);
    setResult(`Added ${r.added} to the finish line.${r.skipped ? ` Skipped ${r.skipped} already there.` : ""}`);
    return r.intel;
  }).then(ok => { if (ok) { setText(""); setFound(null); setAcceptance([]); } });

  return <section aria-labelledby="agr-h" data-intel-editing={editing || undefined}>
    <Title order={3} size="h5" id="agr-h">Add from your agreement</Title>
    <Stack gap="xs" maw={720}>
      <Textarea label="Paste the agreement, statement of work or proposal" description="Read here in your browser. Only the lines you tick are saved."
        value={text} onChange={e => { setText(e.currentTarget.value); setFound(null); }} maxLength={AGREEMENT_MAX_CHARS} autosize minRows={3} maxRows={12} />
      <div><Button variant="default" leftSection={<Search size={14} aria-hidden="true" />} disabled={!text.trim() || !!busy} onClick={find}>Find deliverables</Button></div>
      {result && <Text size="sm" role="status" className="feedback-line">{result}</Text>}
      {found && !found.length && <Text size="sm" c="dimmed" role="status">No deliverables found. Bulleted or numbered lists under headings like Deliverables or Scope work best.</Text>}
      {found && found.length > 0 && <Stack gap={6}>
        <Group gap="xs" justify="space-between">
          <Text size="sm" fw={600} role="status">Found {found.length}. Untick anything that is not part of the job.</Text>
          <Group gap={4}>
            <Button size="compact-sm" variant="subtle" onClick={() => setFound(l => l?.map(c => ({ ...c, picked: true })) ?? null)}>Tick all</Button>
            <Button size="compact-sm" variant="subtle" onClick={() => setFound(l => l?.map(c => ({ ...c, picked: false })) ?? null)}>Untick all</Button>
          </Group>
        </Group>
        <ul className="plan-list agreement-list">{found.map((c, i) => <li key={c.key} className="agreement-row">
          <Checkbox checked={c.picked} onChange={e => update(c.key, { picked: e.currentTarget.checked })} aria-label={`Add deliverable ${i + 1}`} />
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <TextInput size="xs" aria-label={`Deliverable ${i + 1} title`} value={c.title} maxLength={MAX_TITLE} disabled={!c.picked} onChange={e => update(c.key, { title: e.currentTarget.value })} />
            {(c.section || c.detail) && <Text size="xs" c="dimmed">{[c.section, c.detail].filter(Boolean).join(" · ")}</Text>}
          </Stack>
        </li>)}</ul>
        {acceptance.length > 0 && <Stack gap={2}>
          <Checkbox checked={confirmed && withAcceptance} disabled={!confirmed} onChange={e => setWithAcceptance(e.currentTarget.checked)}
            label={`Also add ${acceptance.length} acceptance ${acceptance.length === 1 ? "line" : "lines"} to the finish line`}
            description={confirmed ? acceptance.slice(0, 3).join(" · ") + (acceptance.length > 3 ? ` · +${acceptance.length - 3} more` : "") : "Confirm the finish line first to add acceptance lines."} />
        </Stack>}
        <div><Button leftSection={<Plus size={14} aria-hidden="true" />} disabled={!picked.length || (!!busy && busy !== "agreement")} loading={busy === "agreement"} onClick={add}>
          {picked.length ? `Add ${picked.length} to the finish line` : "Tick at least one"}
        </Button></div>
      </Stack>}
    </Stack>
  </section>;
}
