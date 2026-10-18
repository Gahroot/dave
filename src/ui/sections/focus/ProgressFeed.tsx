import { useEffect, useState } from "react";
import { Alert, Badge, Card, Group, List, Stack, Text } from "@mantine/core";
import { GitCommitHorizontal } from "lucide-react";
import type { ProgressReport } from "../../../work/types.ts";
import type { StatusSpec } from "../../status.ts";
import { PanelHead } from "../../components/WorkspacePrimitives.tsx";
import { workApi } from "../../work-api.ts";

const FEED_SPEC: StatusSpec = { tone: "blue", icon: GitCommitHorizontal, label: "What moved" };

const VERDICT: Record<ProgressReport["verdict"], { label: string; color: string }> = {
  moved: { label: "Moved", color: "green" },
  partial: { label: "Partly moved", color: "blue" },
  no_match: { label: "Not on the plan", color: "gray" },
  failed: { label: "Run failed", color: "red" },
};
const STATE: Record<string, string> = {
  not_implemented: "not built", implementation_observed: "looks implemented", unverified: "reported, not checked", verified: "verified", blocked: "blocked", unknown: "unknown",
  open: "open", in_progress: "in progress", done: "done", dropped: "dropped", obsolete: "obsolete",
};
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

/** "What moved" panel: one card per work event report. Pass `reports` to render them, or leave it out to fetch the latest. */
export function ProgressFeed({ reports: given }: { reports?: ProgressReport[] }) {
  const [fetched, setFetched] = useState<ProgressReport[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (given) return;
    const ac = new AbortController();
    workApi.progress(10, ac.signal).then((r) => { if (!ac.signal.aborted) setFetched(r.reports); })
      .catch((e: unknown) => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Progress unavailable. Retry."); });
    return () => ac.abort();
  }, [given]);
  const reports = given ?? fetched;
  return <section aria-labelledby="moved-h" className="app-panel">
    <PanelHead id="moved-h" title="What moved" spec={reports?.length ? FEED_SPEC : { ...FEED_SPEC, tone: "gray" }} count={reports?.length}
      note={reports?.length ? "New work compared with each finish line. Only your check marks an item verified." : undefined} />
    <Stack gap="sm" className="panel-body">
    {error && <Alert color="red" title="Progress could not load" role="alert">{error}</Alert>}
    {!error && reports === null && <Text role="status">Loading progress…</Text>}
    {reports?.length === 0 && <Text c="dimmed" role="status">No new work seen yet. When an EZ Coder run finishes or you commit, DAVE compares it with the finish line here.</Text>}
    {reports?.map((r) => <Card key={r.eventId} withBorder radius="md" padding="sm"><Stack gap={6}>
      <Group gap="xs" wrap="wrap" justify="space-between">
        <Text fw={600} style={{ overflowWrap: "anywhere", flex: "1 1 16rem" }}>{r.headline}</Text>
        <Badge color={VERDICT[r.verdict].color} variant="light">{VERDICT[r.verdict].label}</Badge>
      </Group>
      <Text size="xs" c="dimmed">{r.projectName} · {when(r.at)} · {r.finishLine.verified} of {r.finishLine.total} verified ({r.finishLine.percentDone}%)</Text>
      {r.advanced.length > 0 && <><Text size="sm" fw={600}>Advanced</Text><List size="sm" spacing={2}>
        {r.advanced.map((d) => <List.Item key={d.itemId} style={{ overflowWrap: "anywhere" }}>{d.title}: {STATE[d.from.evidenceState]} → {STATE[d.to.evidenceState]}</List.Item>)}
      </List></>}
      {r.stillMissing.length > 0 && <><Text size="sm" fw={600}>Still missing</Text><List size="sm" spacing={2}>
        {r.stillMissing.slice(0, 8).map((m, i) => <List.Item key={`${m.itemId ?? "step"}-${i}`} style={{ overflowWrap: "anywhere" }}>{m.title} <Text span size="xs" c="dimmed">({m.why})</Text></List.Item>)}
        {r.stillMissing.length > 8 && <List.Item>…and {r.stillMissing.length - 8} more</List.Item>}
      </List></>}
      {r.nextBefore?.id !== r.nextAfter?.id && <Text size="sm" style={{ overflowWrap: "anywhere" }}>Next action changed from {r.nextBefore?.title ?? "nothing"} → {r.nextAfter?.title ?? "nothing"}</Text>}
    </Stack></Card>)}
    </Stack>
  </section>;
}
