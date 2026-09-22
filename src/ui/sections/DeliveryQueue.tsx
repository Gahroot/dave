import { useState } from "react";
import { Button, Stack, Text } from "@mantine/core";
import type { QueueEntry } from "../../model/delivery-queue.ts";
import { deliveryApi } from "../delivery-api.ts";

/** Presentation only. The shared inbox owns delivery reads. */
export function DeliveryQueue({ entry }: { entry: QueueEntry }) {
  return <><Text fw={600}>{entry.step.headline}</Text><Text size="sm">{entry.state === "paused" ? "Paused · " : ""}{entry.step.why}</Text></>;
}

/** Start/pause control, shown next to a project's own delivery detail. */
export function EngagementButton({ projectId, revision, engagement, disabled, onSaved }: {
  projectId: string; revision: number; engagement: "active" | "paused" | null; disabled: boolean; onSaved: (value: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = engagement === "active" ? "paused" : "active";
  const run = async () => {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try { onSaved(await deliveryApi(`/api/projects/${encodeURIComponent(projectId)}/delivery/coordination/engage`, { expectedRevision: revision, state: next })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change this. Reload before retrying."); }
    finally { setBusy(false); }
  };
  return <Stack gap="xs">
    <Button variant="default" disabled={busy || disabled} onClick={() => void run()}>
      {engagement === "active" ? "Pause this one" : engagement === "paused" ? "Pick this back up" : "Start delivering this"}
    </Button>
    {error && <Text size="sm" c="red" role="alert">{error}</Text>}
  </Stack>;
}
