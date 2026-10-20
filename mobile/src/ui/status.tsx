/**
 * The status language on the phone. Specs come from the shared map
 * (src/ui/status.ts: RUN_STATUS, NEXT_STEP, INBOX_KIND, ITEM_STATUS, …) so a
 * state has the same tone, icon and word on both apps. Never invent a second
 * map; if a spec is missing, add it to src/ui/status.ts.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import type { StatusSpec, Tone } from "../../../src/ui/status.ts";
import { colors, radius, space, text, tints, tones } from "./theme";

export { type StatusSpec, type Tone };

/** A colored icon. Decorative unless labelled: the visible word carries the meaning. */
export function StatusIcon({ spec, size = 16, label }: { spec: StatusSpec; size?: number; label?: string }) {
  const Icon = spec.icon;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spec.spin) return;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spec.spin, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View
    accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label}
    importantForAccessibility={label ? "yes" : "no-hide-descendants"}
    style={spec.spin ? { transform: [{ rotate }] } : undefined}>
    <Icon size={size} color={tones[spec.tone]} strokeWidth={2} />
  </Animated.View>;
}

/** Icon plus word: the standard way to show any domain state. */
export function StatusMark({ spec, children, size = 16, strong = false }: { spec: StatusSpec; children?: ReactNode; size?: number; strong?: boolean }) {
  return <View style={styles.mark}>
    <StatusIcon spec={spec} size={size} />
    <Text style={[text.small, strong && styles.strong]}>{children ?? spec.label}</Text>
  </View>;
}

/** Status icon on a soft tile of its tone: the lead of a row or a section heading. */
export function StatusTile({ spec, size = 16 }: { spec: StatusSpec; size?: number }) {
  return <View style={[styles.tile, { backgroundColor: tints[spec.tone], width: size + 12, height: size + 12 }]}>
    <StatusIcon spec={spec} size={size} />
  </View>;
}

/** A small count; solid only for amber/red where the owner must act. Zero is hidden. */
export function CountPill({ value, tone }: { value: number; tone?: Tone }) {
  if (!value) return null;
  const solid = tone === "amber" || tone === "red";
  return <View style={[styles.pill, solid ? { backgroundColor: tones[tone] } : styles.pillQuiet]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Text style={[styles.pillText, solid && { color: "#fff" }]}>{value}</Text>
  </View>;
}

export type LadderStep = Readonly<{ spec: StatusSpec; title: string; detail: string; state: "done" | "current" | "todo" | "separate" }>;
/** Keeps four facts apart: what the agent reported, what checks proved, what you accepted, what shipped. */
export function TrustLadder({ steps, label = "What has and has not happened" }: { steps: readonly LadderStep[]; label?: string }) {
  return <View accessibilityLabel={label} style={styles.ladder}>
    {steps.map((step) => <View key={step.title} style={[styles.step, { borderTopColor: step.state === "separate" ? colors.control : tones[step.spec.tone] }, step.state === "separate" && styles.stepSeparate]}>
      <View style={styles.mark}><StatusIcon spec={step.spec} size={16} /><Text style={[text.small, styles.strong]}>{step.title}</Text></View>
      <Text style={text.caption}>{step.detail}</Text>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  mark: { flexDirection: "row", alignItems: "center", gap: space.xs + 2, flexShrink: 1 },
  strong: { fontWeight: "600" },
  tile: { alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  pill: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  pillQuiet: { backgroundColor: colors.selected },
  pillText: { fontSize: 12, fontWeight: "600", color: colors.ink },
  ladder: { gap: space.sm },
  step: { borderTopWidth: 3, paddingTop: space.xs + 2, gap: space.xxs },
  stepSeparate: { borderStyle: "dashed" },
});
