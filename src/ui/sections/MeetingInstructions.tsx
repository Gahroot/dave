import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import type { InstructionsProfile, MeetingRow, MeetingsState } from "../../meetings/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { parseRoute } from "../navigation.ts";
import { MeetingDisclosure } from "../components/MeetingDisclosure.tsx";

const MAX = 4000;
const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";

/** The owner's reading instructions: they steer focus and wording; DAVE's rules stay fixed. */
export function MeetingInstructions({ state, onChanged }: { state: MeetingsState | null; onChanged: () => void }) {
  const [profile, setProfile] = useState<InstructionsProfile | null>(null), [draft, setDraft] = useState("");
  const [stale, setStale] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false), [agreed, setAgreed] = useState(false);
  const lock = useRef(false);
  const dirty = !!profile && draft !== profile.instructions;
  useDraftGuard(dirty, hash => { const r = parseRoute(hash); return r.destination === "meetings" && r.section === "instructions" && !r.rec; });

  const load = async (signal?: AbortSignal) => {
    const [p, m] = await Promise.all([
      deliveryApi<InstructionsProfile>("/api/meetings/instructions", undefined, signal),
      deliveryApi<{ meetings: MeetingRow[] }>("/api/meetings/recordings", undefined, signal),
    ]);
    if (signal?.aborted) return;
    setProfile(p); setDraft(p.instructions); setStale(m.meetings.filter(x => x.staleInstructions).length);
  };
  useEffect(() => { const ac = new AbortController(); load(ac.signal).catch(e => { if (!ac.signal.aborted) setError(errorText(e)); }); return () => ac.abort(); }, []);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); await load(); setNotice(done); onChanged(); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const reanalyze = async (consent: boolean) => {
    const body = consent && state ? { consentVersion: state.analysis.disclosure.version } : {};
    if (await run(() => deliveryApi("/api/meetings/reanalyze", body), "Re-analysis started for up to 10 meetings, newest first.")) { setReviewing(false); setAgreed(false); }
  };

  if (!profile) return error ? <Alert color="red" title="Instructions unavailable" role="alert">{error}</Alert> : <Text role="status">Loading instructions…</Text>;
  return <Stack gap="sm" className="form-stage">
    <Text size="sm">Tell DAVE what to look for in your meetings. DAVE's own rules still apply: only project work, exact quotes, and nothing closed without you.</Text>
    <Textarea label="Reading instructions" autosize minRows={8} maxRows={20} value={draft} onChange={e => setDraft(e.currentTarget.value)} disabled={busy}
      description={`${draft.length} of ${MAX} characters${profile.source === "default" ? " · Using DAVE's default" : ""}`} error={draft.length > MAX ? `Shorten to ${MAX} characters or fewer` : undefined} />
    {error && <Alert color="red" title="Instructions need attention" role="alert">{error}</Alert>}
    {notice && <Text size="sm" role="status">{notice}</Text>}
    <Group gap="xs">
      <Button disabled={busy || !dirty || !draft.trim() || draft.length > MAX} onClick={() => void run(() => deliveryApi("/api/meetings/instructions", { instructions: draft }), "Instructions saved. New analyses use them.")}>Save instructions</Button>
      <Button variant="subtle" color="dark" disabled={busy || profile.source === "default"} onClick={() => void run(() => deliveryApi("/api/meetings/instructions/reset", {}), "Reset to DAVE's default instructions.")}>Reset to default</Button>
      {dirty && <Button variant="subtle" color="dark" disabled={busy} onClick={() => setDraft(profile.instructions)}>Discard changes</Button>}
    </Group>
    {stale > 0 && <Stack gap="xs">
      <Text size="sm">{stale} meeting{stale === 1 ? " was" : "s were"} analyzed with older instructions.</Text>
      <Group><Button variant="default" disabled={busy || dirty || !state?.analysis.openAIConnected} onClick={() => state?.analysis.on ? void reanalyze(false) : setReviewing(true)}>Analyze up to 10 again</Button></Group>
      {dirty && <Text size="xs" c="dimmed">Save your changes first.</Text>}
    </Stack>}
    <Modal opened={reviewing && !!state} onClose={() => { setReviewing(false); setAgreed(false); }} title="Analyze these meetings again?" centered size="lg">
      {state && <Stack>
        <Text size="sm">Automatic analysis is off. This sends up to 10 meetings, once.</Text>
        <MeetingDisclosure disclosure={{ ...state.analysis.disclosure, sections: state.analysis.disclosure.sections.slice(0, 1) }} />
        <Checkbox label="Send these meetings to my OpenAI connection" checked={agreed} onChange={e => setAgreed(e.currentTarget.checked)} />
        <Group><Button variant="default" onClick={() => { setReviewing(false); setAgreed(false); }}>Cancel</Button><Button disabled={!agreed || busy} onClick={() => void reanalyze(true)}>Analyze again</Button></Group>
      </Stack>}
    </Modal>
  </Stack>;
}
