import { useState } from "react";
import { Badge, Box, Button, Flex, Group, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import type { PreparedAction, PreparedOp } from "../../../intel/next-types.ts";
import type { NextActInput } from "../../next-api.ts";
import { CopyText } from "../../components/CopyText.tsx";

const DRAFT_LABEL = { message: "Message", brief: "Brief", checklist: "Checklist", agenda: "Agenda" } as const;
const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/**
 * One prepared action: what to do, why now, the ready draft, one primary button, Skip and Later.
 * `hand_to_ezcoder` is never sent to DAVE: the card offers "Copy brief" instead (Pew starts EZ Coder after a yes).
 */
export function PreparedActionCard({ action, onAct, busy = false, error = null }: {
  action: PreparedAction; onAct: (input: NextActInput) => void; busy?: boolean; error?: string | null;
}) {
  const [mode, setMode] = useState<"none" | "skip" | "later">("none");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(tomorrow);
  const run = (op: PreparedOp) => onAct({ op: op.op });
  const handOff = action.primary.op.op === "hand_to_ezcoder";
  const copyOnly = action.primary.op.op === "copy";
  const extra = action.secondary.filter((s) => s.op.op !== "skip" && s.op.op !== "defer" && s.op.op !== "copy" && s.op.op !== "hand_to_ezcoder");
  return <Stack gap="sm" data-testid="prepared-action" style={{ minWidth: 0 }}>
    <div>
      <Text size="xs" c="dimmed">{action.projectName}</Text>
      <Text fw={600} size="lg" style={{ overflowWrap: "anywhere" }}>{action.title}</Text>
      <Text size="sm"><strong>Why now:</strong> {action.whyNow}</Text>
    </div>
    {action.draft && <Box>
      <Text size="xs" fw={600}>{DRAFT_LABEL[action.draft.kind]}{action.draft.to ? ` to ${action.draft.to}` : ""}{action.draft.subject ? `: ${action.draft.subject}` : ""}</Text>
      <ScrollArea.Autosize mah={220} type="auto" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 6 }}>
        <Text component="pre" size="sm" p="xs" m={0} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{action.draft.text}</Text>
      </ScrollArea.Autosize>
    </Box>}
    {!!action.doneWhen.length && <Text size="sm"><strong>Done when:</strong> {action.doneWhen.join("; ")}</Text>}
    {!!action.evidence.length && <Group gap={6} wrap="wrap">{action.evidence.map((e, i) => <Badge key={`${e.label}-${i}`} variant="light" maw="100%" h="auto" py={2}
      styles={{ label: { whiteSpace: "normal", overflow: "visible", overflowWrap: "anywhere" } }}>{e.label}</Badge>)}</Group>}
    {action.missing.map((m) => <Text key={m} size="xs" c="dimmed">DAVE couldn't confirm: {m}</Text>)}
    <Flex className="prepared-actions" direction={{ base: "column", sm: "row" }} gap="xs" align={{ base: "stretch", sm: "flex-start" }} wrap="wrap">
      {handOff || copyOnly
        ? <CopyText text={action.draft?.text ?? action.title} label={handOff ? "Copy brief" : action.primary.label} variant="filled" disabled={busy} onCopied={copyOnly ? () => run(action.primary.op) : undefined} />
        : <Button loading={busy} onClick={() => run(action.primary.op)}>{action.primary.label}</Button>}
      {!copyOnly && !handOff && action.draft && <CopyText text={action.draft.text} label="Copy" disabled={busy} />}
      {extra.map((s) => <Button key={`${s.op.op}-${s.label}`} variant="default" disabled={busy} onClick={() => run(s.op)}>{s.label}</Button>)}
      <Button variant="subtle" disabled={busy} onClick={() => setMode(mode === "skip" ? "none" : "skip")}>Skip</Button>
      <Button variant="subtle" disabled={busy} onClick={() => setMode(mode === "later" ? "none" : "later")}>Later</Button>
    </Flex>
    {mode === "skip" && <Flex direction={{ base: "column", sm: "row" }} gap="xs" align={{ base: "stretch", sm: "flex-end" }}>
      <TextInput label="Reason (optional)" maxLength={500} value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
      <Button disabled={busy} onClick={() => onAct(reason.trim() ? { op: "skip", note: reason.trim() } : { op: "skip" })}>Skip this</Button>
    </Flex>}
    {mode === "later" && <Flex direction={{ base: "column", sm: "row" }} gap="xs" align={{ base: "stretch", sm: "flex-end" }}>
      <TextInput type="date" label="Show it again on" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
      <Button disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(date)} onClick={() => onAct({ op: "defer", date })}>Put off</Button>
    </Flex>}
    {error && <Text size="sm" c="red" role="alert">{error}</Text>}
  </Stack>;
}
