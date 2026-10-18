import { useCallback, useEffect, useState } from "react";
import { Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { ChevronDown, ChevronRight, Scale } from "lucide-react";
import type { ReviewReport } from "../../../intel/ledger-types.ts";
import { REVIEW_DEFAULT_DAYS } from "../../../intel/ledger-types.ts";
import { reviewApi } from "../../review-api.ts";
import { ErrorLine } from "./parts.tsx";

const pct = (r: number): string => `${Math.round(r * 100)}%`;
const BASIS_LABEL = { explicit: "you said so", observed: "seen in your work" } as const;
const day = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

/** How DAVE's picks compared with yours. Suggestions apply only when you press the button. */
export function RecommendationReview({ defaultOpen = false, days = REVIEW_DEFAULT_DAYS }: { defaultOpen?: boolean; days?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setError(null);
    reviewApi.review(days, signal).then(setReport, (e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load the review"); });
  }, [days]);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [open, load]);

  const apply = async (id: string) => {
    setBusy(id); setError(null);
    try { setReport((await reviewApi.applySuggestion(id)).report); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not apply that suggestion"); load(); }
    finally { setBusy(null); }
  };

  const resolved = report ? Object.entries(report.totals).reduce((n, [k, v]) => (k === "open" ? n : n + v), 0) : 0;
  return <section className="app-panel recommendation-review" aria-labelledby="rr-h">
    <UnstyledButton onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="rr-body" style={{ width: "100%", padding: "12px 16px" }}>
      <Group gap="xs" wrap="nowrap">
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <Scale size={16} aria-hidden />
        <Text id="rr-h" fw={600}>How DAVE's picks compared with yours</Text>
      </Group>
    </UnstyledButton>
    {open && <Stack id="rr-body" gap="sm" px="md" pb="md">
      {error && <ErrorLine message={error} onRetry={() => load()} />}
      {!report && !error && <Text size="sm" c="dimmed">Loading…</Text>}
      {report && resolved === 0 && <Text size="sm" c="dimmed">Not enough history yet. DAVE compares its picks with what you did once a few recommendations have played out.</Text>}
      {report && resolved > 0 && <>
        <Text size="sm">
          {report.agreementRate === null ? "No followed, overridden or skipped picks in the last " : `You followed DAVE's pick ${pct(report.agreementRate)} of the time in the last `}
          {report.days} days ({report.totals.followed} followed, {report.totals.overridden} overridden, {report.totals.skipped} skipped, {report.totals.open} still open).
        </Text>
        {report.patterns.length > 0 && <ul className="plain-list" aria-label="Patterns">{report.patterns.map(p => <li key={p}><Text size="sm">{p}</Text></li>)}</ul>}
        {report.suggestions.length > 0 && <Stack gap="xs" aria-label="Suggested direction changes">
          {report.suggestions.map(s => <Group key={s.id} gap="sm" wrap="wrap">
            <Text size="sm" style={{ flex: "0 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{s.text}</Text>
            <Button size="xs" variant="light" loading={busy === s.id} disabled={!!busy} onClick={() => void apply(s.id)}>Apply</Button>
          </Group>)}
        </Stack>}
        {report.overrides.length > 0 && <div>
          <Text size="sm" fw={600}>Recent times you chose differently</Text>
          <ul className="plain-list">{report.overrides.map((o, i) => <li key={`${o.at}:${i}`} className="row-sub" style={{ overflowWrap: "anywhere" }}>
            <Text size="sm" component="span">DAVE: {o.recommended}</Text>
            {o.actual && <Text size="sm" component="span"> → You: {o.actual}</Text>}
            {o.reason && <Text size="sm" component="span" c="dimmed"> ({o.reason})</Text>}
            {o.basis && <span className="quiet-tag"> · {BASIS_LABEL[o.basis]}</span>}
            {day(o.at) && <span className="quiet-tag"> · {day(o.at)}</span>}
          </li>)}</ul>
        </div>}
      </>}
    </Stack>}
  </section>;
}
