import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Group, List, Modal, Stack, Text, Title } from "@mantine/core";
import { Power, PowerOff, RefreshCw, Smartphone } from "lucide-react";
import type { MobilePairingStatus } from "../../mobile/service.ts";
import { deliveryApi } from "../delivery-api.ts";
import { relative } from "../format.ts";
import { CopyText } from "../components/CopyText.tsx";
import { StatusTile } from "../components/Status.tsx";
import { CONNECTION } from "../status.ts";
import type { StatusSpec } from "../status.ts";

const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
const WAITING: StatusSpec = { tone: "amber", icon: Smartphone, label: "Waiting for your phone" };

/** Connections → Phone: opt-in LAN access for the one paired phone. */
export function PhonePairing() {
  const [state, setState] = useState<MobilePairingStatus | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirmNew, setConfirmNew] = useState(false);
  const lock = useRef(false);

  const load = async (signal?: AbortSignal) => {
    try { const value = await deliveryApi<MobilePairingStatus>("/api/mobile/pairing", undefined, signal); if (!signal?.aborted) { setState(value); setError(""); } }
    catch (e) { if (!signal?.aborted) setError(errorText(e, "Phone status unavailable. Retry.")); }
  };
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort(); }, []);
  // While the code is showing, poll so the card switches to paired as soon as the phone scans.
  const waiting = !!state?.enabled && !state.paired && !!state.link;
  useEffect(() => {
    if (!waiting) return;
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (document.visibilityState === "visible") await load(ac.signal); if (!ac.signal.aborted) timer = setTimeout(poll, 3000); };
    timer = setTimeout(poll, 3000);
    return () => { ac.abort(); clearTimeout(timer); };
  }, [waiting]);

  const run = async (action: "enable" | "disable" | "rotate") => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { setState(await deliveryApi<MobilePairingStatus>(`/api/mobile/pairing/${action}`, {})); }
    catch (e) { setError(errorText(e, "Phone access action failed. Retry.")); }
    finally { setBusy(false); lock.current = false; }
  };

  const mark: StatusSpec = !state ? CONNECTION.pending : state.error ? CONNECTION.error : !state.enabled ? { ...CONNECTION.disconnected, label: "Off" }
    : state.paired ? { ...CONNECTION.connected, label: "Paired" } : !state.listening ? CONNECTION.error : WAITING;
  const port = state?.port ?? 4318;
  return <Card withBorder radius="md" padding="md" className="connection-card" data-tone={mark.tone} aria-labelledby="phone-pairing-title"><Stack gap="sm">
    <Title order={3} id="phone-pairing-title" className="connection-title"><StatusTile spec={mark} size={18} />Phone</Title>
    <Text role="status" fw={600}>{!state ? "Loading status…" : !state.enabled ? "Phone access is off." : state.paired ? "A phone is paired." : state.listening ? "Ready to pair. Scan the code with your phone." : "Phone access is on but not listening."}</Text>
    {(error || state?.error) && <Alert color="red" title="Phone access needs attention" role="alert">{error || state?.error}</Alert>}

    {state && !state.enabled && <>
      <Text size="sm">Use DAVE from your phone on the same Wi-Fi. Turning this on opens a listener on your local network (port {port}) that only accepts encrypted requests from the one phone you pair. Everything else on the network gets nothing.</Text>
      <Text size="xs" c="dimmed">The pairing key is kept only in your macOS Keychain. Turn it off at any time; the phone stays paired until you pair a new one.</Text>
      <Group><Button leftSection={<Power size={16} aria-hidden="true" />} disabled={busy} onClick={() => void run("enable")}>Turn on phone access</Button></Group>
    </>}

    {state?.enabled && !state.paired && state.link && state.qrSvg && <>
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.qrSvg)}`} width={240} height={240}
        alt="Pairing QR code. Scan it with the DAVE app on your phone." style={{ background: "#fff", padding: 12, borderRadius: 8, border: "1px solid var(--mantine-color-gray-3)", alignSelf: "flex-start" }} />
      <List type="ordered" size="sm" spacing={4}>
        <List.Item>Open the DAVE app on your phone and tap Scan (or point the iPhone Camera at the code).</List.Item>
        <List.Item>Confirm pairing on the phone. This card updates by itself once it is paired.</List.Item>
      </List>
      <Text size="sm" c="dimmed">Your phone will try: {state.hosts.join(", ")} on port {state.port}.</Text>
      <CopyText text={state.link} label="Copy pairing link" />
      <Text size="xs" c="dimmed">The link contains the pairing key. Treat it as a secret until your phone has scanned it; if it leaked, pair a new phone.</Text>
    </>}

    {state?.enabled && state.paired && <Text size="sm">Paired phone {state.device ?? ""}{state.claimedAt ? `, since ${relative(state.claimedAt)}` : ""}. Only this phone is accepted.</Text>}

    {state?.enabled && <Group gap="xs">
      {(state.paired || state.link) && <Button variant="default" leftSection={<RefreshCw size={16} aria-hidden="true" />} disabled={busy} onClick={() => setConfirmNew(true)}>Pair a new phone</Button>}
      {!state.listening && <Button leftSection={<Power size={16} aria-hidden="true" />} disabled={busy} onClick={() => void run("enable")}>Retry turning on</Button>}
      <Button variant="subtle" color="red" leftSection={<PowerOff size={16} aria-hidden="true" />} disabled={busy} onClick={() => void run("disable")}>Turn off phone access</Button>
    </Group>}

    <Modal opened={confirmNew} onClose={() => setConfirmNew(false)} title="Pair a new phone?" centered>
      <Stack><Text>This makes a new pairing code. The phone paired now stops working at once and must scan the new code to reconnect.</Text>
        <Group><Button variant="default" onClick={() => setConfirmNew(false)}>Keep current phone</Button><Button color="red" disabled={busy} onClick={() => { setConfirmNew(false); void run("rotate"); }}>Unpair and show new code</Button></Group></Stack>
    </Modal>
  </Stack></Card>;
}
