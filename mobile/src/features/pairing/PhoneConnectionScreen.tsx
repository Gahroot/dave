/**
 * Phone connection: which Mac this phone is paired with, how it reaches it,
 * a manual check, and Forget this Mac (phone side only).
 */
import { useState } from "react";
import { router } from "expo-router";
import { RefreshCw, Trash2 } from "lucide-react-native";
import { MOBILE_PROTOCOL_VERSION } from "../../../../src/mobile/protocol.ts";
import { CONNECTION } from "../../../../src/ui/status.ts";
import { useConnection } from "../../lib/connection";
import { Banner, Body, Button, Caption, confirm, EmptyState, KeyValue, Muted, Panel, Screen, Stack, tick } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { space } from "../../ui/theme";
import { problemTitle, problemTone } from "./ConnectionBanner";

export function PhoneConnectionScreen() {
  const { state, problem, recheck, unpair } = useConnection();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [forgetting, setForgetting] = useState(false);

  if (state.status !== "ready") {
    return <Screen><EmptyState title="Not paired" message="This phone isn't paired with a Mac." action={<Button variant="primary" title="Pair with your Mac" onPress={() => router.replace("/pair")} />} /></Screen>;
  }

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try { await recheck(); setCheckedAt(new Date()); } finally { setChecking(false); }
  };

  const forget = async () => {
    const ok = await confirm({
      title: `Forget ${state.name}?`,
      message: "This phone stops talking to that Mac and removes the pairing key from this phone. Nothing changes on the Mac: it still lists this phone until you use Pair a new phone or turn off phone access there.",
      confirmLabel: "Forget this Mac",
      destructive: true,
    });
    if (!ok) return;
    setForgetting(true);
    await unpair();
    tick();
    router.replace("/pair");
  };

  const spec = problem ? { ...CONNECTION.error, label: problemTitle(problem.kind) } : checking ? CONNECTION.pending : CONNECTION.connected;
  return <Screen onRefresh={() => void check()} refreshing={checking}>
    <Panel title={state.name} spec={spec} note={problem ? problemTitle(problem.kind) : "Paired"}>
      <KeyValue label="Address in use">{`${state.host}:${state.offer.port}`}</KeyValue>
      <KeyValue label={state.offer.hosts.length === 1 ? "Advertised" : "All addresses"}>{state.offer.hosts.join(", ")}</KeyValue>
      <KeyValue label="Port">{String(state.offer.port)}</KeyValue>
      <KeyValue label="This phone">{`${state.deviceId.slice(0, 14)}…`}</KeyValue>
      <KeyValue label="Protocol">{`Version ${MOBILE_PROTOCOL_VERSION}`}</KeyValue>
    </Panel>

    <Panel title="Check connection" note="Asks your Mac to answer on each advertised address, best first.">
      <Stack gap={space.sm}>
        {checkedAt && !checking && (problem
          ? <Banner tone={problemTone(problem.kind)} title={problemTitle(problem.kind)} message={problem.message} />
          : <StatusMark spec={CONNECTION.connected}>{`${state.name} answered on ${state.host} at ${checkedAt.toLocaleTimeString()}.`}</StatusMark>)}
        <Button variant="primary" title={checking ? "Checking…" : "Check connection"} icon={RefreshCw} loading={checking} onPress={() => void check()} />
      </Stack>
    </Panel>

    <Panel title="Turning off or replacing">
      <Body>Phone access is controlled on the Mac: DAVE → Connections → Phone. Turn off phone access there, or use Pair a new phone to rotate the key, which unpairs this phone at once.</Body>
      <Muted>Forget this Mac only clears this phone. It doesn't change anything on the Mac.</Muted>
      <Button variant="danger-subtle" title="Forget this Mac" icon={Trash2} loading={forgetting} disabled={forgetting} onPress={() => void forget()} />
      <Caption>You'll need the Mac's pairing code to connect again.</Caption>
    </Panel>
  </Screen>;
}
