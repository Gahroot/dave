/** Native port of src/ui/sections/CleanupView.tsx: bulk clean-up of meeting noise. User-initiated only; every batch can be undone. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Check, Eraser, RefreshCw, Undo2 } from "lucide-react-native";
import {
  BUCKET_LABEL, BUCKET_NOTE, type TriageAction, type TriageBatch, type TriageBucket, type TriagePreview, type TriageResult, type TriageUndoResult,
} from "../../../../src/triage/types.ts";
import {
  batchLine, bucketState, canMarkDone, defaultSelection, groupByBucket, projectOptions, pruneSelection, resultText, selectedEntries, summarySentence,
  toggleBucket, toggleOne, undoText,
} from "../../../../src/ui/cleanup-model.ts";
import { ApiError, describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { announceDataChanged, onDataChanged, type DataScope } from "../../lib/data-events";
import {
  Banner, Button, Caption, Divider, EmptyState, Inline, LoadingState, Muted, Panel, Screen, SelectField, Small, Stack, Tag, TextField, Toggle, confirm, tick as haptic,
} from "../../ui/primitives";
import { space } from "../../ui/theme";
import { Checkbox } from "../agents/components";
import { cleanupFilter, confirmText, confirmedHiddenText, selectedCountText } from "./model";

const SCOPES: DataScope[] = ["meetings", "intel", "portfolio"];
const ALL = "__all__";
const TIMEOUT = 30_000;

/** The web's TriageRequestError wording: server text plus status; 404 means the server predates Clean up. */
function message(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown } | null;
    const why = e.status === 404 ? (body && typeof body.error === "string" ? body.error : "Clean up is not available on this server yet.") : e.message;
    return e.status ? `${why} (${e.status})` : why;
  }
  return describeError(e);
}

type Outcome = { text: string; batchId: string | null; error?: boolean };

export function CleanupScreen({ bucket }: { bucket: TriageBucket | null }) {
  const api = useApi();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [includeConfirmed, setIncludeConfirmed] = useState(false);
  const [tick, setTick] = useState(0);
  const [preview, setPreview] = useState<TriagePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<{ value: string; label: string }[]>([]);
  const [batches, setBatches] = useState<TriageBatch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const working = useRef(false);
  const first = useRef(true);
  const linked = useRef(bucket);
  // Following another bucket link while the screen is open starts that bucket's selection afresh.
  if (linked.current !== bucket) { linked.current = bucket; first.current = true; }

  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => onDataChanged((scopes) => { if (scopes.some((s) => s === "meetings" || s === "intel")) setTick((t) => t + 1); }), []);
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current) setTick((t) => t + 1);
    focusedOnce.current = true;
  }, []));

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    api.post<TriagePreview>("/api/triage/preview", { filter: cleanupFilter(projectId, query, includeConfirmed) }, { signal: abort.signal, timeoutMs: TIMEOUT }).then((next) => {
      if (abort.signal.aborted) return;
      setPreview(next);
      setError(null);
      if (!projectId) setProjects(projectOptions(next.entries));
      if (first.current) { first.current = false; setSelected(defaultSelection(next.entries, bucket)); }
      else setSelected((s) => pruneSelection(s, next.entries));
    }).catch((e: unknown) => { if (!abort.signal.aborted) setError(message(e)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [api, projectId, query, includeConfirmed, tick, bucket]);

  useEffect(() => {
    const abort = new AbortController();
    api.get<{ batches: TriageBatch[] }>("/api/triage/batches", { signal: abort.signal, timeoutMs: TIMEOUT })
      .then((r) => { if (!abort.signal.aborted) setBatches(r.batches); })
      .catch(() => { if (!abort.signal.aborted) setBatches((b) => b ?? []); });
    return () => abort.abort();
  }, [api, tick]);

  const entries = useMemo(() => preview?.entries ?? [], [preview]);
  const groups = useMemo(() => groupByBucket(entries), [entries]);
  const chosen = selectedEntries(selected, entries);
  const doneOk = canMarkDone(chosen);
  const count = chosen.length;

  const apply = async (action: TriageAction) => {
    if (working.current || !chosen.length) return;
    const ask = confirmText(action, chosen.length);
    if (!(await confirm({ ...ask, destructive: action === "clear" }))) return;
    working.current = true;
    setBusy(action);
    try {
      const result = await api.post<TriageResult>("/api/triage/apply", { keys: chosen.map((e) => e.key), action }, { timeoutMs: TIMEOUT });
      setOutcome({ text: resultText(result, action), batchId: result.batchId });
      haptic();
      if (result.changed) announceDataChanged(SCOPES); else setTick((t) => t + 1);
    } catch (e) {
      setOutcome({ text: message(e), batchId: null, error: true });
      if (e instanceof ApiError && e.status === 409) setTick((t) => t + 1);
    } finally { working.current = false; setBusy(null); }
  };

  const undo = async (batchId: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(`undo:${batchId}`);
    try {
      const r = await api.post<TriageUndoResult>("/api/triage/undo", { batchId }, { timeoutMs: TIMEOUT });
      setOutcome({ text: undoText(r.restored, r.skipped), batchId: null });
      haptic();
      announceDataChanged(SCOPES);
    } catch (e) {
      setOutcome({ text: message(e), batchId: null, error: true });
      if (e instanceof ApiError && e.status === 409) setTick((t) => t + 1);
    } finally { working.current = false; setBusy(null); }
  };

  const refresh = () => setTick((t) => t + 1);
  const outcomeBatch = outcome?.batchId ?? null;

  return <Screen refreshing={loading && !!preview} onRefresh={refresh}>
    <Panel title="Clean up" note={preview ? summarySentence(preview.counts, preview.total) : loading ? "Looking for noise…" : undefined}>
      {!!preview?.confirmedHidden && <Muted>{confirmedHiddenText(preview.confirmedHidden)}</Muted>}
      <SelectField label="Project" placeholder="All projects" value={projectId ?? ALL}
        options={[{ value: ALL, label: "All projects" }, ...projects]} onChange={(v) => setProjectId(v === ALL ? null : v)} />
      <TextField label="Search" placeholder="Title, project or meeting" value={text} onChangeText={setText} autoCorrect={false} />
      <Toggle label="Include ones you confirmed" value={includeConfirmed} onValueChange={setIncludeConfirmed} />
    </Panel>

    {outcome && <Banner tone={outcome.error ? "red" : "green"} title={outcome.error ? "Clean up needs attention" : "Done"} message={outcome.text}
      action={outcomeBatch ? <Inline><Button title="Undo" icon={Undo2} compact loading={busy === `undo:${outcomeBatch}`} disabled={!!busy}
        onPress={() => void undo(outcomeBatch)} /></Inline> : undefined} />}

    {error && <Banner tone="red" title="Could not load Clean up" message={error}
      action={<Inline><Button title="Retry" icon={RefreshCw} compact onPress={refresh} /></Inline>} />}
    {!preview && loading && !error && <LoadingState label="Loading Clean up…" />}
    {preview && !groups.length && <Panel><EmptyState title="Nothing to clean up"
      message="Overdue or stale meeting promises, old client asks and drafted decisions show up here when there are some." /></Panel>}

    {groups.map((g) => {
      const state = bucketState(selected, g.entries);
      const total = preview?.counts[g.bucket] ?? g.entries.length;
      return <Panel key={g.bucket} title={BUCKET_LABEL[g.bucket]} count={total}
        note={`${BUCKET_NOTE[g.bucket]}${total > g.entries.length ? ` Showing ${g.entries.length} of ${total}.` : ""}`}>
        <Checkbox label={`Select all (${g.entries.length})${state === "some" ? " · some selected" : ""}`} checked={state === "all"} disabled={!!busy}
          onChange={() => setSelected((s) => toggleBucket(s, g.entries))} />
        <Divider />
        {g.entries.map((e) => <View key={e.key} style={styles.entry}>
          <Checkbox label={e.title} checked={selected.has(e.key)} disabled={!!busy} onChange={() => setSelected((s) => toggleOne(s, e.key))} />
          <Inline style={styles.meta}>
            {e.confirmed && <Tag>You confirmed this</Tag>}
            {e.projectName && <Caption>{e.projectName}</Caption>}
            {e.reasons.map((r) => <Caption key={r}>{r}</Caption>)}
          </Inline>
        </View>)}
      </Panel>;
    })}

    {batches && batches.length > 0 && <Panel title="Recent clean-ups">
      {batches.map((b) => <Stack key={b.id} gap={space.xs}>
        <Small>{batchLine(b)}</Small>
        {b.undoneAt ? <Inline><Tag>Undone</Tag></Inline>
          : <Inline><Button title="Undo" icon={Undo2} compact loading={busy === `undo:${b.id}`} disabled={!!busy}
            onPress={() => void undo(b.id)} accessibilityLabel={`Undo: ${b.summary}`} /></Inline>}
      </Stack>)}
    </Panel>}

    {groups.length > 0 && <Panel title="Clean up actions" note={selectedCountText(count)}>
      <Button title={`Clear ${count} selected`} icon={Eraser} variant="primary" disabled={!count || (!!busy && busy !== "clear")} loading={busy === "clear"}
        onPress={() => void apply("clear")} />
      <Button title={`Mark ${count} done`} icon={Check} disabled={!doneOk || (!!busy && busy !== "done")} loading={busy === "done"}
        onPress={() => void apply("done")} />
      {count > 0 && !doneOk && <Caption>Mark done works only on promises and items that look done.</Caption>}
    </Panel>}
  </Screen>;
}

const styles = StyleSheet.create({
  entry: { gap: space.xxs },
  meta: { paddingLeft: space.xl },
});
