import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import type { AttentionAction, InboxItem, Portfolio } from "../../shared/types.ts";
import { InboxView } from "./InboxView.tsx";

export function TodayView({ portfolio, busyId, onResolve, onSeen, actions, returnId }: {
  portfolio: Portfolio;
  returnId?: string | null;
  busyId: string | null;
  onResolve: (id: string, action: AttentionAction) => Promise<boolean>;
  onSeen: (ids: string[]) => void;
  actions?: (item: InboxItem) => ReactNode;
}) {
  const [mode, setMode] = useState<"top" | "all" | "history">(returnId ? "all" : "top");
  const [page, setPage] = useState(() => Math.max(0, Math.floor(portfolio.inbox.findIndex((i) => i.id === returnId) / 100)));
  const [message, setMessage] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const history = (portfolio.history ?? []).filter((i) => !portfolio.inbox.some((open) => open.id === i.id));
  const list = mode === "history" ? history : portfolio.inbox;
  const items = mode === "top" ? list.slice(0, 3) : list.slice(page * 100, page * 100 + 100);
  const displayed = items.map((i) => i.id).join(",");
  useEffect(() => {
    if (!displayed || mode === "history") return;
    const markVisible = () => { if (document.visibilityState === "visible") onSeen(displayed.split(",")); };
    markVisible();
    document.addEventListener("visibilitychange", markVisible);
    return () => document.removeEventListener("visibilitychange", markVisible);
  }, [displayed, mode, onSeen]);
  const resolve = async (id: string, action: AttentionAction) => {
    if (await onResolve(id, action)) {
      setLastId(action === "undo" ? null : id);
      setMessage(action === "undo" ? "Reopened locally if this evidence is still current." :
        action === "tomorrow" ? "Snoozed until 09:00 tomorrow. See the stored deadline in History." :
        "Saved locally. Upstream tasks are unchanged.");
      heading.current?.focus();
    }
  };
  return <Stack gap="sm">
    <Title order={2} tabIndex={-1} ref={heading}>Decision queue</Title>
    <Text size="sm">{portfolio.newCount ?? 0} new since your previous visit · {portfolio.inbox.length} current decisions</Text>
    <Group gap="xs">{([['top', 'Recommended'], ['all', `All (${portfolio.inbox.length})`], ['history', `History / snoozed (${history.length})`]] as const).map(([value, label]) =>
      <Button key={value} variant={mode === value ? "filled" : "default"} aria-pressed={mode === value} onClick={() => { setMode(value); setPage(0); }}>{label}</Button>)}</Group>
    <Text size="xs" c="dimmed">Handled remembers this evidence locally. Tomorrow snoozes this revision; changed requests can surface separately.</Text>
    <div role="status">{message}{lastId && <Button ml="xs" variant="default" disabled={!!busyId} onClick={() => void resolve(lastId, "undo")}>Undo last action</Button>}</div>
    {items.length ? <InboxView items={items} busyId={busyId} history={mode === "history"} onResolve={(id, action) => void resolve(id, action)} actions={actions} /> :
      <Alert color="gray" title={mode === "history" ? "No saved history here" : "No current decisions in checked evidence"}>Unchecked or unavailable projects may still need you. Check coverage below.</Alert>}
    {mode === "top" && portfolio.inbox.length > 3 && <Button variant="default" onClick={() => setMode("all")}>Inspect {portfolio.inbox.length - 3} remaining decisions</Button>}
    {mode !== "top" && list.length > 100 && <Group><Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button disabled={(page + 1) * 100 >= list.length} onClick={() => setPage((p) => p + 1)}>Next</Button></Group>}
  </Stack>;
}
