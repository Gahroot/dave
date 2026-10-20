/** Port of src/ui/sections/DeliveryQueue.tsx EngagementButton: start/pause delivering a project. */
import { useState } from "react";
import { CirclePause, CirclePlay } from "lucide-react-native";
import { Banner, Button, Stack } from "../../ui/primitives";
import { useDeliveryApi } from "./api";

export function EngagementButton({ projectId, revision, engagement, disabled, onSaved }: {
  projectId: string; revision: number; engagement: "active" | "paused" | null; disabled: boolean; onSaved: (value: unknown) => void;
}) {
  const call = useDeliveryApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = engagement === "active" ? "paused" : "active";
  const run = async () => {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try { onSaved(await call(`/api/projects/${encodeURIComponent(projectId)}/delivery/coordination/engage`, { expectedRevision: revision, state: next })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change this. Reload before retrying."); }
    finally { setBusy(false); }
  };
  return <Stack gap={4}>
    <Button icon={engagement === "active" ? CirclePause : CirclePlay} loading={busy} disabled={disabled}
      title={engagement === "active" ? "Pause this one" : engagement === "paused" ? "Pick this back up" : "Start delivering this"} onPress={() => void run()} />
    {error ? <Banner tone="red" title="Not changed" message={error} /> : null}
  </Stack>;
}
