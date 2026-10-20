import { useRef, useState } from "react";
import { CircleX, LoaderCircle, Plug, RotateCcw, Unplug, X } from "lucide-react-native";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { Banner, Button, Caption, Inline, Muted, Panel, SelectField, Small, confirm, tick } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";

export type { ProviderStatus } from "./types";
import type { ProviderStatus } from "./types";

/** OpenAI connection states from the provider service, as marks (same as the web). */
export const PROVIDER_STATE = {
  connected: { tone: "green", icon: Plug, label: "Connected" },
  connecting: { tone: "blue", icon: LoaderCircle, label: "Connecting", spin: true },
  disconnected: { tone: "gray", icon: Unplug, label: "Not connected" },
  reconnect_required: { tone: "amber", icon: CircleX, label: "Reconnect needed" },
} as const satisfies Readonly<Record<string, StatusSpec>>;
export function providerMark(state: string | undefined): StatusSpec {
  return state === "connected" || state === "connecting" || state === "reconnect_required" ? PROVIDER_STATE[state] : PROVIDER_STATE.disconnected;
}

type Storage = "keychain" | "session";
const STORAGE_OPTIONS = [
  { value: "keychain", label: "macOS Keychain: Dave-owned persistent connection" },
  { value: "session", label: "Session only: lost when Dave stops" },
] as const;

export function OpenAICard({ status, reload }: { status: ProviderStatus | null; reload: () => Promise<void> }) {
  const api = useApi();
  const [storage, setStorage] = useState<Storage>("keychain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const pending = status?.operation?.status === "pending";

  const action = async (name: "connect" | "restore" | "cancel" | "disconnect") => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const body = name === "connect" || name === "restore" ? { storage } : name === "cancel" ? { operationId: status?.operation?.id } : {};
      await api.post(`/api/providers/openai/${name}`, body);
      tick();
    } catch (e) { setError(describeError(e)); }
    finally { await reload(); setBusy(false); lock.current = false; }
  };
  const disconnect = async () => {
    if (await confirm({ title: "Disconnect OpenAI?", message: "This removes DAVE's selected stored connection. Planning will need a new connection; saved plans and evidence remain. It does not cancel your provider subscription.", confirmLabel: "Confirm disconnect", cancelLabel: "Keep connection", destructive: true }))
      await action("disconnect");
  };
  const mark = status ? providerMark(status.openai.state) : PROVIDER_STATE.connecting;
  const problem = status?.operation?.message ?? status?.operation?.error ?? status?.openai.error;

  return <Panel title="OpenAI" spec={mark} note={`Status: ${status?.openai.state ?? "loading"}${status?.operation ? ` · Sign-in ${status.operation.status}` : ""}`}>
    <Muted>Requested model: gpt-6-astra. Listing does not establish account entitlement.</Muted>
    <Banner tone="blue" title="Sign-in happens on your Mac" message="Connect OpenAI opens the sign-in page in a browser on the Mac running DAVE. Finish it there; this phone shows the result." />
    {status && status.openai.state !== "connected" && !pending && <>
      <SelectField label="Credential storage for connect or restore" value={storage} options={STORAGE_OPTIONS} onChange={setStorage} disabled={busy} />
      <Caption>Keychain never silently falls back to session storage. Restore explicitly reads the selected store. Disconnect removes Dave's selected stored connection.</Caption>
    </>}
    {problem ? <Banner tone="red" title="OpenAI connection needs attention" message={`${problem} Retry sign-in for expired credentials; free the callback port without stopping another app, or explicitly choose session storage if Keychain is unavailable.`} /> : null}
    {error ? <Banner tone="red" title="Connection action needs attention" message={error} /> : null}
    <Inline>
      {status && status.openai.state !== "connected" && !pending && <>
        <Button title="Connect OpenAI" icon={Plug} variant="primary" loading={busy} onPress={() => void action("connect")} />
        <Button title="Restore connection" icon={RotateCcw} disabled={busy} onPress={() => void action("restore")} />
      </>}
      {pending && <Button title="Cancel sign-in" icon={X} disabled={busy} onPress={() => void action("cancel")} />}
      {status && !pending && <Button title="Disconnect OpenAI" icon={Unplug} variant="danger-subtle" disabled={busy} onPress={() => void disconnect()} />}
    </Inline>
    {pending && <StatusMark spec={PROVIDER_STATE.connecting}>Waiting for your browser sign-in on the Mac. You can cancel; Dave does not claim connection until sign-in succeeds.</StatusMark>}
    {!status && <Small>Connection status not loaded.</Small>}
  </Panel>;
}
