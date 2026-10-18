/** Phone ports of src/ui/components/{Labels,StaleBadge}.tsx. Tooltips become a tap that reveals the reason. */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ClockAlert, Lightbulb, Pencil, Pin, Terminal, type LucideIcon } from "lucide-react-native";
import { colors, radius, space, text, tones } from "../../ui/theme";
import type { Tone } from "../../ui/status";

function QuietTag({ icon: Icon, tone, children, why }: { icon: LucideIcon; tone: Tone; children: ReactNode; why?: string }) {
  const [open, setOpen] = useState(false);
  const body = <View style={styles.tag}><Icon size={12} color={tones[tone]} /><Text style={text.caption}>{children}</Text></View>;
  if (!why) return body;
  return <View style={styles.wrap}>
    <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={`${String(children)}. ${why}`} accessibilityState={{ expanded: open }} hitSlop={8}>{body}</Pressable>
    {open && <Text style={text.caption} selectable>{why}</Text>}
  </View>;
}

/** Ordinary git and session activity. Never called progress. */
export function TechnicalActivityBadge({ detail }: { detail?: string }) {
  return <QuietTag icon={Terminal} tone="gray" why={detail || "Observed machine activity: commits, sessions, task updates"}>Technical activity</QuietTag>;
}
/** An inferred next step: a suggestion, never an instruction. */
export function SuggestionBadge({ detail }: { detail?: string }) {
  return <QuietTag icon={Lightbulb} tone="violet" why={detail ?? "Inferred from the evidence: a suggestion, not a fact"}>Suggestion</QuietTag>;
}
export function EditedBadge() {
  return <QuietTag icon={Pencil} tone="green" why="You corrected this summary; it will not be overwritten">Your edit</QuietTag>;
}
export function PinnedBadge() {
  return <QuietTag icon={Pin} tone="blue">Pinned</QuietTag>;
}
/** Out-of-date data: amber clock, neutral text; tap for the reason. */
export function StaleBadge({ label, why }: { label: string; why: string }) {
  return <QuietTag icon={ClockAlert} tone="amber" why={why}>{label}</QuietTag>;
}

const styles = StyleSheet.create({
  wrap: { gap: space.xxs, flexShrink: 1 },
  tag: { flexDirection: "row", alignItems: "center", gap: space.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space.xs + 2, paddingVertical: 2, alignSelf: "flex-start" },
});
