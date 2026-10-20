/**
 * Pair with your Mac: scan the QR from DAVE → Connections → Phone (or paste
 * the link, or arrive from the iPhone Camera through a dave://pair link),
 * confirm what this grants, then claim the pairing with a sealed `hello`.
 *
 * Every route into pairing stops at the confirm step: a link never pairs on
 * its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import * as Haptics from "expo-haptics";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Camera, ClipboardPaste, QrCode, RefreshCw, Settings, Smartphone, X } from "lucide-react-native";
import { parsePairingLink, type PairingOffer } from "../../../../src/mobile/protocol.ts";
import { CONNECTION } from "../../../../src/ui/status.ts";
import { useConnection } from "../../lib/connection";
import {
  Banner, Body, Button, Caption, IconButton, Inline, KeyValue, LoadingState, Muted, Panel, SafeScreen, Stack, TextField, Title, BottomSpacer,
} from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { colors, radius, space } from "../../ui/theme";

type Step =
  | { kind: "scan" }
  | { kind: "confirm"; offer: PairingOffer }
  | { kind: "pairing"; offer: PairingOffer }
  | { kind: "failed"; offer: PairingOffer; message: string };

const NOT_DAVE = "That code isn't a DAVE pairing code. Scan the code under DAVE → Connections → Phone on your Mac.";

/** Only dave://pair links are ours; anything else (expo dev links, other routes) is ignored silently. */
function isPairLink(url: string): boolean {
  return /^dave:\/\/pair(?:[/?#]|$)/i.test(url.trim());
}

export function PairScreen() {
  const { state, pair } = useConnection();
  const paired = state.status === "ready";
  const [step, setStep] = useState<Step>({ kind: "scan" });
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // Scan lock: the camera reports the same code many times a second.
  const locked = useRef(false);
  const lastRejected = useRef<string | null>(null);
  const handledUrl = useRef<string | null>(null);

  const offerFound = useCallback((offer: PairingOffer) => {
    locked.current = true;
    setNotice(null);
    setStep({ kind: "confirm", offer });
  }, []);

  // Deep link from the iPhone Camera: read the full raw URL, fragment (the key) included.
  const linkingUrl = Linking.useLinkingURL();
  useEffect(() => {
    if (!linkingUrl || handledUrl.current === linkingUrl || !isPairLink(linkingUrl)) return;
    handledUrl.current = linkingUrl;
    const parsed = parsePairingLink(linkingUrl);
    if (parsed.ok) offerFound(parsed.offer);
    else setNotice(`This pairing link can't be used: ${parsed.error}`);
  }, [linkingUrl, offerFound]);

  // Development convenience only: the simulator has no camera.
  useEffect(() => {
    if (!__DEV__) return;
    const dev = process.env.EXPO_PUBLIC_DEV_PAIRING;
    if (dev) { setDraft(dev); setPasteOpen(true); }
  }, []);

  const onScanned = useCallback((result: BarcodeScanningResult) => {
    if (locked.current) return;
    const data = result.data;
    if (data === lastRejected.current) return;
    const parsed = parsePairingLink(data);
    if (parsed.ok) { void Haptics.selectionAsync().catch(() => undefined); offerFound(parsed.offer); return; }
    lastRejected.current = data;
    setNotice(isPairLink(data) ? `This pairing code can't be used: ${parsed.error}` : NOT_DAVE);
  }, [offerFound]);

  const usePasted = () => {
    const parsed = parsePairingLink(draft.trim());
    if (!parsed.ok) { setDraftError(isPairLink(draft) ? parsed.error : "Paste the link that starts with dave://pair, from Copy pairing link on your Mac."); return; }
    setDraftError(null);
    offerFound(parsed.offer);
  };

  const backToScan = () => {
    locked.current = false;
    lastRejected.current = null;
    setStep({ kind: "scan" });
  };

  const confirmPair = async (offer: PairingOffer) => {
    setStep({ kind: "pairing", offer });
    const result = await pair(offer);
    if (!result.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setStep({ kind: "failed", offer, message: result.message });
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    router.replace("/(tabs)");
  };

  if (step.kind !== "scan") {
    const { offer } = step;
    const busy = step.kind === "pairing";
    return <SafeScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Title>Pair with {offer.name}?</Title>
        <Panel title="This Mac" spec={CONNECTION.pending}>
          <KeyValue label="Mac">{offer.name}</KeyValue>
          <KeyValue label={offer.hosts.length === 1 ? "Address" : "Addresses"}>{offer.hosts.join(", ")}</KeyValue>
          <KeyValue label="Port">{String(offer.port)}</KeyValue>
        </Panel>
        <Panel title="What this allows">
          <Body>This phone gets the same control of DAVE on that Mac as the web app: it can read everything and take the same actions.</Body>
          <Muted>One phone per pairing. Once this phone pairs, any other phone with this code is refused. To move to a new phone, use Pair a new phone on the Mac.</Muted>
          {paired && <Banner tone="amber" title="Replaces the current pairing"
            message={`This phone is paired with ${state.name} now. Pairing replaces that on this phone; the other Mac is not changed.`} />}
        </Panel>
        {step.kind === "failed" && <Banner tone="red" title="Pairing didn't finish" message={step.message} />}
        {busy && <View accessibilityLiveRegion="polite"><StatusMark spec={CONNECTION.pending}>Contacting {offer.name}…</StatusMark></View>}
        <Stack gap={space.sm}>
          <Button variant="primary" title={step.kind === "failed" ? "Try again" : "Pair this phone"} icon={step.kind === "failed" ? RefreshCw : Smartphone}
            loading={busy} disabled={busy} onPress={() => void confirmPair(offer)} />
          <Button variant="subtle" title="Scan a different code" disabled={busy} onPress={backToScan} />
        </Stack>
        <BottomSpacer />
      </ScrollView>
    </SafeScreen>;
  }

  return <SafeScreen>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.head}>
        <View style={styles.flex}><Title>Pair with your Mac</Title></View>
        {paired && <IconButton icon={X} label="Close" onPress={() => router.back()} />}
      </View>
      <Panel title="On your Mac">
        <Body>1. Open DAVE → Connections → Phone.</Body>
        <Body>2. Turn on phone access. A pairing code appears.</Body>
        <Body>3. Scan it here. This phone and the Mac must be on the same Wi-Fi.</Body>
      </Panel>

      <Panel title="Scan pairing code" padded>
        {!permission ? <LoadingState label="Checking camera access…" />
          : permission.granted ? <View style={styles.cameraFrame}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned}
              accessibilityLabel="Camera viewfinder. Point it at the pairing code on your Mac." />
            <View pointerEvents="none" style={styles.overlay}><View style={styles.reticle} /></View>
          </View>
          : permission.canAskAgain ? <Stack gap={space.sm}>
            <Muted>DAVE uses the camera only to scan the pairing code shown on your Mac.</Muted>
            <Button variant="primary" title="Allow camera" icon={Camera} onPress={() => void requestPermission()} />
          </Stack>
          : <Stack gap={space.sm}>
            <Banner tone="amber" title="Camera access is off" message="Turn on Camera for DAVE in Settings, or paste the pairing link below." />
            <Button title="Open Settings" icon={Settings} onPress={() => void Linking.openSettings()} />
          </Stack>}
        {notice && <View accessibilityLiveRegion="polite"><Banner tone="amber" title="Keep scanning" message={notice} /></View>}
      </Panel>

      <Panel title="No camera?" note="On the Mac, use Copy pairing link, then paste it here.">
        {pasteOpen ? <Stack gap={space.sm}>
          <TextField label="Pairing link" value={draft} onChangeText={(v) => { setDraft(v); setDraftError(null); }} multiline autoCapitalize="none" autoCorrect={false}
            placeholder="dave://pair?…" error={draftError} help="The link contains the pairing key. Don't share it." />
          <Inline><Button variant="primary" title="Continue" icon={QrCode} disabled={!draft.trim()} onPress={usePasted} /></Inline>
        </Stack> : <Inline><Button title="Paste pairing link" icon={ClipboardPaste} onPress={() => setPasteOpen(true)} /></Inline>}
      </Panel>
      <Caption>You will confirm the Mac's name and address before anything is paired.</Caption>
      <BottomSpacer />
    </ScrollView>
  </SafeScreen>;
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
  cameraFrame: { aspectRatio: 1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.ink },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  reticle: { width: "70%", aspectRatio: 1, borderWidth: 3, borderColor: colors.onAccent, borderRadius: radius.lg },
});
