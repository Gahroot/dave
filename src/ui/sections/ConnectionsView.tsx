import { useEffect, useState } from "react";
import { Alert, Button, Card, Group, NativeSelect, Stack, Text, Title } from "@mantine/core";
import type { ProviderService } from "../../providers/index.ts";
import { deliveryApi } from "../delivery-api.ts";

type Status = ReturnType<ProviderService["status"]>;
export function ConnectionsView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [storage, setStorage] = useState("keychain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => { try { setStatus(await deliveryApi<Status>("/api/providers")); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Status unavailable. Retry."); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (status?.operation?.status !== "pending") return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.status]);
  const action = async (name: string) => {
    setBusy(true); setError("");
    try { await deliveryApi(`/api/providers/openai/${name}`, name === "connect" || name === "restore" ? { storage } : name === "cancel" ? { operationId: status?.operation?.id } : {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Connection action failed. Retry."); }
    finally { setBusy(false); }
  };
  const pending = status?.operation?.status === "pending";
  return <Stack gap="md">
    <Title order={2}>Connections</Title>
    <Text>Planning sends only your explicitly previewed and approved project packet to the selected provider. Subscription and model access depend on your account. Dave never switches model, provider or billing method silently.</Text>
    {error && <Alert color="red" title="Connection action needs attention" role="alert">{error}</Alert>}
    <Button variant="default" disabled={busy} onClick={() => void load()}>Reload connection status</Button>
    {!status && <Text role="status">Connection status not loaded.</Text>}
    <Card withBorder radius="md" padding="md"><Stack gap="sm">
      <Title order={3}>OpenAI</Title>
      <Text role="status">Status: {status?.openai.state ?? "loading"}{status?.operation ? ` · Sign-in ${status.operation.status}` : ""}</Text>
      <Text>Requested model: gpt-6-astra. Listing does not establish account entitlement.</Text>
      <NativeSelect label="Credential storage for connect or restore" value={storage} onChange={e => setStorage(e.currentTarget.value)} disabled={busy || pending} data={[{ value: "keychain", label: "macOS Keychain: Dave-owned persistent connection" }, { value: "session", label: "Session only: lost when Dave stops" }]} />
      <Text size="sm">Keychain never silently falls back to session storage. Restore explicitly reads the selected store. Disconnect removes Dave's selected stored connection.</Text>
      {(status?.openai.error || status?.operation?.error) && <Alert color="red" title="OpenAI connection needs attention">{status.operation?.message ?? status.operation?.error ?? status.openai.error} Retry sign-in for expired credentials; free the callback port without stopping another app, or explicitly choose session storage if Keychain is unavailable.</Alert>}
      <Group><Button disabled={busy || pending} onClick={() => void action("connect")}>Connect OpenAI</Button><Button variant="default" disabled={busy || pending} onClick={() => void action("restore")}>Restore connection</Button>{pending && <Button variant="default" disabled={busy} onClick={() => void action("cancel")}>Cancel sign-in</Button>}<Button variant="default" disabled={busy || !status} onClick={() => void action("disconnect")}>Disconnect OpenAI</Button></Group>
      {pending && <Text>Waiting for your browser sign-in. You can cancel; Dave does not claim connection until sign-in succeeds.</Text>}
    </Stack></Card>
    <Card withBorder radius="md" padding="md"><Stack gap="sm"><Title order={3}>Anthropic / Claude subscription</Title><Text>Status: {status?.claude.state ?? "loading"}</Text><Text>Requested models: claude-fable-5-1, claude-opus-5.</Text><Text>{status?.claude.error ?? "Claude remains unavailable until verified official-runtime isolation is supported."}</Text><Text>No Claude login or inference is started here. No Anthropic API-key fallback. Credentials and subscription billing remain owned by the official Claude application.</Text></Stack></Card>
    <Button component="a" href="#projects" variant="default">Choose project goal and planning model</Button>
  </Stack>;
}
