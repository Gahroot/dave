/** Port of src/ui/sections/delivery/StagePanels.tsx plus small shared rows. */
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { usePreventRemove } from "expo-router";
import { Bot, Copy } from "lucide-react-native";
import { MILESTONE_STATUS, type MilestoneStatus } from "../../../../src/ui/status.ts";
import { Button, confirm, Inline, Stack } from "../../ui/primitives";
import { StatusIcon, type StatusSpec } from "../../ui/status";
import { colors, space, text } from "../../ui/theme";

export type Method = "connected" | "manual";

export function WorkMethod({ method, onChange, connected, manual }: { method: Method; onChange: (method: Method) => void; connected: ReactNode; manual: ReactNode }) {
  return <Stack gap={space.sm}>
    <View accessibilityLabel="Delivery method"><Inline>
      <Button title="Run in DAVE" icon={Bot} compact variant={method === "connected" ? "primary" : "secondary"} accessibilityHint={method === "connected" ? "Selected" : undefined} onPress={() => onChange("connected")} />
      <Button title="Use another tool" icon={Copy} compact variant={method === "manual" ? "primary" : "secondary"} accessibilityHint={method === "manual" ? "Selected" : undefined} onPress={() => onChange("manual")} />
    </Inline></View>
    {method === "connected" ? connected : manual}
  </Stack>;
}

/** The milestone order as a visible stepper: one mark and one word per piece, the current one emphasised. */
export function MilestoneSequence({ items, current }: { items: { id: string; title: string; status: MilestoneStatus }[]; current?: string | undefined }) {
  if (!items.length) return null;
  return <View accessibilityLabel={`Milestones, ${items.filter((item) => item.status === "accepted").length} of ${items.length} accepted`} style={styles.sequence}>
    {items.map((item, index) => {
      const spec = MILESTONE_STATUS[item.status];
      const isCurrent = item.id === current;
      return <View key={item.id} style={[styles.step, isCurrent && styles.current]}>
        <StatusIcon spec={spec} />
        <View style={styles.flex}>
          <Text style={[text.small, isCurrent && styles.bold]}>{index + 1}. {item.title}{isCurrent ? " (current)" : ""}</Text>
          <Text style={text.caption}>{spec.label}</Text>
        </View>
      </View>;
    })}
  </View>;
}

/** One result line: status icon, title, and detail. Text is plain and selectable (it may be agent-reported). */
export function ResultRow({ spec, title, detail, mono = false, children }: { spec: StatusSpec; title: string; detail?: string; mono?: boolean; children?: ReactNode }) {
  return <View style={styles.result}>
    <StatusIcon spec={spec} />
    <View style={styles.flex}>
      <Text style={mono ? text.mono : text.small} selectable>{title}</Text>
      {detail ? <Text style={text.caption} selectable>{detail}</Text> : null}
      {children}
    </View>
  </View>;
}

/** Ask before leaving the screen with an unsaved delivery draft (the web's useDraftGuard). */
export function useDraftGuard(dirty: boolean) {
  usePreventRemove(dirty, ({ repeat }) => {
    void confirm({ title: "Leave with unsaved delivery changes?", message: "Your delivery draft on this screen is not saved and will be lost.", confirmLabel: "Leave", destructive: true })
      .then((ok) => { if (ok) repeat(); });
  });
}

/** A collapsible region whose open state the parent controls (the web's <details open onToggle>). */
export function useOpen(initial: boolean): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(initial);
  return [open, setOpen];
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  sequence: { gap: space.xs },
  step: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xxs },
  current: { backgroundColor: colors.selected },
  result: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.xs },
});
