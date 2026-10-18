/**
 * The shared connection banner above the tabs: the last transport problem in
 * plain words, with the one useful next step. Hidden while the Mac answers.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { QrCode, RefreshCw } from "lucide-react-native";
import { useConnection, type ConnectionProblem } from "../../lib/connection";
import { Banner, Button, Inline } from "../../ui/primitives";
import { colors, space } from "../../ui/theme";
import type { Tone } from "../../ui/status";

const TITLES: Record<ConnectionProblem["kind"], string> = {
  unreachable: "Can't reach your Mac",
  timeout: "Your Mac is slow to answer",
  unpaired: "This phone is no longer paired",
  refused: "Paired with another phone",
  clock: "Clocks don't match",
  "rate-limited": "Your Mac is pausing requests",
  protocol: "Unreadable answer from your Mac",
};

export function problemTitle(kind: ConnectionProblem["kind"]): string { return TITLES[kind]; }
export function problemTone(kind: ConnectionProblem["kind"]): Tone {
  return kind === "unpaired" || kind === "refused" || kind === "protocol" ? "red" : "amber";
}

export function ConnectionBanner() {
  const { problem, recheck } = useConnection();
  const insets = useSafeAreaInsets();
  const [checking, setChecking] = useState(false);

  const announcement = problem ? `${TITLES[problem.kind]}. ${problem.message}` : null;
  useEffect(() => {
    if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  if (!problem) return null;
  const repair = problem.kind === "unpaired" || problem.kind === "refused";
  const retry = async () => {
    if (checking) return;
    setChecking(true);
    try { await recheck(); } finally { setChecking(false); }
  };
  return <View style={[styles.wrap, { paddingTop: insets.top + space.xs, paddingLeft: insets.left + space.md, paddingRight: insets.right + space.md }]}
    accessibilityLiveRegion="polite">
    <Banner tone={problemTone(problem.kind)} title={TITLES[problem.kind]} message={problem.message} action={<Inline>
      <Button title={checking ? "Checking…" : "Retry"} icon={RefreshCw} compact loading={checking} onPress={() => void retry()}
        accessibilityHint="Asks your Mac again" />
      {repair && <Button title="Pair again" icon={QrCode} compact variant="primary" onPress={() => router.push("/pair")} />}
    </Inline>} />
  </View>;
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.canvas, paddingBottom: space.xs },
});
