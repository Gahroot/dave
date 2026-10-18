/**
 * A floating "Talk to DAVE" mascot button (port of src/ui/voice/VoiceDock.tsx),
 * mounted once by the root layout. Opens /voice; the conversation keeps going
 * while the user moves around the app. Hidden on /voice and /pair.
 */
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MOOD_LABEL } from "../../../../src/ui/mascot/types.ts";
import { isActive, mascotMood } from "../../../../src/ui/voice/machine.ts";
import { DaveMascot } from "../mascot/DaveMascot";
import { colors, radius, shadow, space, text, tints, tones } from "../../ui/theme";
import { dockHidden, isTabPath } from "./model";
import { useVoice } from "./VoiceProvider";

const SIZE = 64;
const TAB_BAR = 49;

export function VoiceDock() {
  const voice = useVoice();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const ring = useRef(new Animated.Value(0)).current;
  const mood = mascotMood(voice.state);
  const active = isActive(voice.state);
  const hidden = dockHidden(pathname);
  const { levels } = voice;

  useEffect(() => {
    if (!active || hidden) { ring.setValue(0); return; }
    const timer = setInterval(() => ring.setValue(Math.max(levels.input(), levels.output())), 100);
    return () => clearInterval(timer);
  }, [active, hidden, levels, ring]);

  if (hidden) return null;
  const approved = active && voice.approval.on;
  const bottom = insets.bottom + (isTabPath(pathname) ? TAB_BAR : 0) + space.md;
  const scale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35], extrapolate: "clamp" });
  return <View pointerEvents="box-none" style={[styles.wrap, { bottom, right: insets.right + space.lg }]}>
    {active && <Animated.View pointerEvents="none" style={[styles.ring, { transform: [{ scale }] }]} />}
    <Pressable onPress={() => router.push("/voice")} accessibilityRole="button"
      accessibilityLabel={active ? `Open voice. DAVE is ${MOOD_LABEL[mood]}${approved ? ". Approve all is on" : ""}` : "Talk to DAVE"}
      style={({ pressed }) => [styles.dock, active && styles.live, pressed && styles.pressed]}>
      <DaveMascot mood={mood} size={SIZE - 8} levels={voice.levels} label="" />
    </Pressable>
    {approved && <View style={styles.badge} pointerEvents="none"><Text style={[text.caption, styles.badgeText]}>Approve all on</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", alignItems: "center", justifyContent: "center", width: SIZE, height: SIZE },
  dock: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", overflow: "hidden", ...shadow, elevation: 4 },
  live: { borderColor: colors.accent, borderWidth: 2 },
  ring: { position: "absolute", width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: tints.blue, borderWidth: 2, borderColor: tones.blue, opacity: 0.6 },
  pressed: { opacity: 0.7 },
  badge: { position: "absolute", top: -space.lg, right: 0, backgroundColor: tints.amber, borderColor: tones.amber, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.xs },
  badgeText: { color: colors.ink, fontWeight: "600" },
});
