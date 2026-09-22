import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Group, Modal, NativeSelect, Stack, Text, Title } from "@mantine/core";
import type { ProviderService } from "../../providers/index.ts";
import { deliveryApi } from "../delivery-api.ts";
import { parseRoute } from "../navigation.ts";
import { PageHeader } from "../components/WorkspacePrimitives.tsx";

type Status = ReturnType<ProviderService["status"]>;
export function ConnectionsView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [storage, setStorage] = useState("keychain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const lock = useRef(false);
  const returnTo = parseRoute(location.hash).returnTo;
  const load = async (signal?: AbortSignal) => { try { const value = await deliveryApi<Status>("/api/providers", undefined, signal); if (!signal?.aborted) { setStatus(value); setError(""); } } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Status unavailable. Retry."); } };
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort(); }, []);
  useEffect(() => {
    if (status?.operation?.status !== "pending") return;
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (document.visibilityState === "visible") await load(ac.signal); if (!ac.signal.aborted) timer = setTimeout(poll, 2000); };
    timer = setTimeout(poll, 2000);
    return () => { ac.abort(); clearTimeout(timer); };
  }, [status?.operation?.status]);
  const action = async (name: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await deliveryApi(`/api/providers/openai/${name}`, name === "connect" || name === "restore" ? { storage } : name === "cancel" ? { operationId: status?.operation?.id } : {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Connection action failed. Retry."); }
    finally { setBusy(false); lock.current = false; }
  };
  const pending = status?.operation?.status === "pending";
  return <Stack gap="md">
    <PageHeader title="Connections" actions={returnTo && <Button component="a" href={returnTo} variant="default">Return to setup</Button>} />
    <Text>Planning sends only your explicitly previewed and approved project packet to the selected provider. Subscription and model access depend on your account. Dave never switches model, provider or billing method silently.</Text>
    {error && <Alert color="red" title="Connection action needs attention" role="alert">{error}</Alert>}
    <Button variant="default" disabled={busy} onClick={() => void load()}>Reload connection status</Button>
    {!status && <Text role="status">Connection status not loaded.</Text>}
    <Card withBorder radius="md" padding="md"><Stack gap="sm">
      <Title order={3}>OpenAI</Title>
      <Text role="status">Status: {status?.openai.state ?? "loading"}{status?.operation ? ` · Sign-in ${status.operation.status}` : ""}</Text>
      <Text>Requested model: gpt-6-astra. Listing does not establish account entitlement.</Text>
      {status && status.openai.state !== "connected" && !pending && <><NativeSelect label="Credential storage for connect or restore" value={storage} onChange={e => setStorage(e.currentTarget.value)} disabled={busy || pending} data={[{ value: "keychain", label: "macOS Keychain: Dave-owned persistent connection" }, { value: "session", label: "Session only: lost when Dave stops" }]} />
      <Text size="sm">Keychain never silently falls back to session storage. Restore explicitly reads the selected store. Disconnect removes Dave's selected stored connection.</Text></>}
      {(status?.openai.error || status?.operation?.error) && <Alert color="red" title="OpenAI connection needs attention">{status.operation?.message ?? status.operation?.error ?? status.openai.error} Retry sign-in for expired credentials; free the callback port without stopping another app, or explicitly choose session storage if Keychain is unavailable.</Alert>}
      <Group>{status && status.openai.state !== "connected" && !pending && <><Button disabled={busy} onClick={() => void action("connect")}>Connect OpenAI</Button><Button variant="default" disabled={busy} onClick={() => void action("restore")}>Restore connection</Button></>}{pending && <Button variant="default" disabled={busy} onClick={() => void action("cancel")}>Cancel sign-in</Button>}{status && !pending && <Button variant="default" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect OpenAI</Button>}</Group>
      {pending && <Text>Waiting for your browser sign-in. You can cancel; Dave does not claim connection until sign-in succeeds.</Text>}
    </Stack></Card>
    <Card withBorder radius="md" padding="md"><Stack gap="sm"><Title order={3}>Anthropic / Claude subscription</Title><Text>Status: {status?.claude.state ?? "loading"}</Text><Text>Requested models: claude-fable-5-1, claude-opus-5.</Text><Text>{status?.claude.error ?? "Claude remains unavailable until verified official-runtime isolation is supported."}</Text><Text>No Claude login or inference is started here. No Anthropic API-key fallback. Credentials and subscription billing remain owned by the official Claude application.</Text></Stack></Card>
    {!returnTo && <Button component="a" href="#projects" variant="default">Choose project goal and planning model</Button>}
    <Modal opened={confirmDisconnect} onClose={() => setConfirmDisconnect(false)} title="Disconnect OpenAI?" centered>
      <Stack><Text>This removes DAVE's selected stored connection. Planning will need a new connection; saved plans and evidence remain. It does not cancel your provider subscription.</Text><Group><Button variant="default" onClick={() => setConfirmDisconnect(false)}>Keep connection</Button><Button color="red" disabled={busy} onClick={() => { setConfirmDisconnect(false); void action("disconnect"); }}>Confirm disconnect</Button></Group></Stack>
    </Modal>
  </Stack>;
}
