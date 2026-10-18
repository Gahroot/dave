import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Select, Switch, Text, TextInput } from "@mantine/core";
import { Check, Eraser, RefreshCw, Search, Undo2 } from "lucide-react";
import { BUCKET_LABEL, BUCKET_NOTE, type TriageAction, type TriageBatch, type TriageBucket, type TriageFilter, type TriagePreview } from "../../triage/types.ts";
import { triageApi, TriageRequestError } from "../triage-api.ts";
import { DATA_CHANGED_EVENT, type DataChangedDetail, type DataScope } from "../../voice/types.ts";
import { batchLine, bucketState, canMarkDone, defaultSelection, groupByBucket, projectOptions, pruneSelection, resultText, selectedEntries, summarySentence, toggleBucket, toggleOne, undoText } from "../cleanup-model.ts";
import { PageHeader } from "../components/WorkspacePrimitives.tsx";

const SCOPES: DataScope[] = ["meetings", "intel", "portfolio"];
const message = (e: unknown): string => e instanceof TriageRequestError || e instanceof Error ? e.message : "Something went wrong. Retry when ready.";
const announceChange = () => window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail: { scopes: SCOPES } }));

type Outcome = { text: string; batchId: string | null; error?: boolean };

export function CleanupView({ bucket }: { bucket: TriageBucket | null }) {
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
  const scrolled = useRef(false);
  const linked = useRef(bucket);
  // Following another bucket link while the page is open starts that bucket's selection afresh.
  if (linked.current !== bucket) { linked.current = bucket; first.current = true; scrolled.current = false; }

  useEffect(() => { const t = window.setTimeout(() => setQuery(text.trim()), 300); return () => window.clearTimeout(t); }, [text]);
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DataChangedDetail | undefined>).detail;
      if (detail?.scopes.some(s => s === "meetings" || s === "intel")) setTick(t => t + 1);
    };
    window.addEventListener(DATA_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const filter: TriageFilter = { ...(projectId ? { projectId } : {}), ...(query ? { text: query } : {}), ...(includeConfirmed ? { includeConfirmed } : {}) };
    setLoading(true);
    triageApi.preview(filter, abort.signal).then(next => {
      setPreview(next);
      setError(null);
      if (!projectId) setProjects(projectOptions(next.entries));
      if (first.current) { first.current = false; setSelected(defaultSelection(next.entries, bucket)); }
      else setSelected(s => pruneSelection(s, next.entries));
    }).catch((e: unknown) => { if (!abort.signal.aborted) setError(message(e)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [projectId, query, includeConfirmed, tick, bucket]);

  useEffect(() => {
    const abort = new AbortController();
    triageApi.batches(abort.signal).then(r => setBatches(r.batches)).catch(() => { if (!abort.signal.aborted) setBatches(b => b ?? []); });
    return () => abort.abort();
  }, [tick]);

  // Open the linked bucket once its section exists.
  useEffect(() => {
    if (scrolled.current || !bucket || !preview) return;
    const head = document.getElementById(`cleanup-${bucket}`);
    if (!head) return;
    scrolled.current = true;
    head.scrollIntoView({ block: "start" });
    head.focus({ preventScroll: true });
  }, [bucket, preview]);

  const entries = useMemo(() => preview?.entries ?? [], [preview]);
  const groups = useMemo(() => groupByBucket(entries), [entries]);
  const chosen = selectedEntries(selected, entries);
  const doneOk = canMarkDone(chosen);

  const apply = useCallback(async (action: TriageAction) => {
    if (working.current || !chosen.length) return;
    working.current = true;
    setBusy(action);
    try {
      const result = await triageApi.apply(chosen.map(e => e.key), action);
      setOutcome({ text: resultText(result, action), batchId: result.batchId });
      if (result.changed) announceChange(); else setTick(t => t + 1);
    } catch (e) { setOutcome({ text: message(e), batchId: null, error: true }); }
    finally { working.current = false; setBusy(null); }
  }, [chosen]);

  const undo = useCallback(async (batchId: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(`undo:${batchId}`);
    try {
      const r = await triageApi.undo(batchId);
      setOutcome({ text: undoText(r.restored, r.skipped), batchId: null });
      announceChange();
    } catch (e) { setOutcome({ text: message(e), batchId: null, error: true }); }
    finally { working.current = false; setBusy(null); }
  }, []);

  const count = chosen.length;
  return <div className="cleanup-page">
    <PageHeader title="Clean up">
      <Text className="cleanup-summary">{preview ? summarySentence(preview.counts, preview.total) : loading ? "Looking for noise…" : ""}</Text>
      {!!preview?.confirmedHidden && <Text size="sm" c="dimmed">{preview.confirmedHidden === 1 ? "1 item you confirmed is hidden." : `${preview.confirmedHidden} items you confirmed are hidden.`}</Text>}
    </PageHeader>

    <div className="cleanup-filters" role="group" aria-label="Filter what to clean up">
      <Select label="Project" placeholder="All projects" data={projects} value={projectId} onChange={setProjectId} clearable allowDeselect comboboxProps={{ withinPortal: true }} />
      <TextInput label="Search" placeholder="Title, project or meeting" leftSection={<Search size={14} aria-hidden="true" />} value={text} onChange={e => setText(e.currentTarget.value)} />
      <Switch label="Include ones you confirmed" checked={includeConfirmed} onChange={e => setIncludeConfirmed(e.currentTarget.checked)} />
    </div>

    <div className="cleanup-outcome" aria-live="polite" role="status">
      {outcome && <div className={`cleanup-outcome-box${outcome.error ? " is-error" : ""}`}>
        <span>{outcome.text}</span>
        {outcome.batchId && <Button size="xs" variant="default" leftSection={<Undo2 size={14} aria-hidden="true" />} loading={busy === `undo:${outcome.batchId}`} disabled={!!busy} onClick={() => { if (outcome.batchId) void undo(outcome.batchId); }}>Undo</Button>}
      </div>}
    </div>

    {error && <Alert color="red" title="Could not load Clean up" role="alert">
      <div className="cleanup-error">{error}<Button size="xs" variant="default" leftSection={<RefreshCw size={14} aria-hidden="true" />} onClick={() => setTick(t => t + 1)}>Retry</Button></div>
    </Alert>}
    {!preview && loading && !error && <Text role="status">Loading Clean up…</Text>}
    {preview && !groups.length && <div className="app-panel"><Text className="panel-empty">Overdue or stale meeting promises, old client asks and drafted decisions show up here when there are some.</Text></div>}

    {groups.map(g => {
      const state = bucketState(selected, g.entries);
      const headId = `cleanup-${g.bucket}`;
      const total = preview?.counts[g.bucket] ?? g.entries.length;
      return <section key={g.bucket} className="app-panel cleanup-bucket" aria-labelledby={headId}>
        <div className="cleanup-bucket-head">
          <h2 id={headId} tabIndex={-1}>{BUCKET_LABEL[g.bucket]}</h2>
          <Text size="sm" c="dimmed">{BUCKET_NOTE[g.bucket]}{total > g.entries.length ? ` Showing ${g.entries.length} of ${total}.` : ""}</Text>
          <Checkbox className="cleanup-select-all" label={<>Select all ({g.entries.length})<span className="visually-hidden"> in {BUCKET_LABEL[g.bucket]}</span></>} checked={state === "all"} indeterminate={state === "some"} disabled={!!busy}
            onChange={() => setSelected(s => toggleBucket(s, g.entries))} />
        </div>
        <ul className="cleanup-list">{g.entries.map(e => {
          const metaId = `cleanup-meta-${e.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
          return <li key={e.key} className="cleanup-row">
            <Checkbox checked={selected.has(e.key)} disabled={!!busy} onChange={() => setSelected(s => toggleOne(s, e.key))} aria-describedby={metaId}
              label={<span className="cleanup-row-title">{e.title}</span>} />
            <div className="cleanup-row-meta" id={metaId}>
              {e.confirmed && <span className="quiet-tag">You confirmed this</span>}
              {e.projectName && <span>{e.projectName}</span>}
              {e.reasons.map(r => <span key={r}>{r}</span>)}
            </div>
          </li>;
        })}</ul>
      </section>;
    })}

    {batches && batches.length > 0 && <section className="app-panel cleanup-batches" aria-labelledby="cleanup-recent">
      <div className="cleanup-bucket-head"><h2 id="cleanup-recent">Recent clean-ups</h2></div>
      <ul className="cleanup-list">{batches.map(b => <li key={b.id} className="cleanup-batch">
        <span>{batchLine(b)}</span>
        {b.undoneAt ? <span className="quiet-tag">Undone</span>
          : <Button size="xs" variant="default" leftSection={<Undo2 size={14} aria-hidden="true" />} loading={busy === `undo:${b.id}`} disabled={!!busy} onClick={() => void undo(b.id)} aria-label={`Undo: ${b.summary}`}>Undo</Button>}
      </li>)}</ul>
    </section>}

    {groups.length > 0 && <div className="cleanup-actionbar" role="region" aria-label="Clean up actions">
      <Text size="sm" className="cleanup-actionbar-count">{count === 1 ? "1 selected" : `${count} selected`}</Text>
      <Button leftSection={<Eraser size={16} aria-hidden="true" />} disabled={!count || (!!busy && busy !== "clear")} loading={busy === "clear"} onClick={() => void apply("clear")}>Clear {count} selected</Button>
      <Button variant="default" leftSection={<Check size={16} aria-hidden="true" />} disabled={!doneOk || (!!busy && busy !== "done")} loading={busy === "done"} onClick={() => void apply("done")}>Mark {count} done</Button>
      {count > 0 && !doneOk && <Text size="xs" c="dimmed" className="cleanup-actionbar-hint">Mark done works only on promises and items that look done.</Text>}
    </div>}
  </div>;
}
