import { useState } from "react";
import { Button, Stack, Text } from "@mantine/core";
import { CirclePause, CirclePlay } from "lucide-react";
import { deliveryApi } from "../delivery-api.ts";

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
    <Button variant="default" leftSection={engagement === "active" ? <CirclePause size={16} aria-hidden="true" /> : <CirclePlay size={16} aria-hidden="true" />} disabled={busy || disabled} onClick={() => void run()}>
      {engagement === "active" ? "Pause this one" : engagement === "paused" ? "Pick this back up" : "Start delivering this"}
    </Button>
    {error && <Text size="sm" c="red" role="alert">{error}</Text>}
  </Stack>;
}
