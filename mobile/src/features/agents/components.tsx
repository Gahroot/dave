/** Agent desk building blocks: checkbox, execution specs, trust ladder, draft guard. */
import { Pressable, StyleSheet, Text } from "react-native";
import { usePreventRemove } from "expo-router";
import { Bot, CircleDashed, GitMerge, Lock, LockOpen, Square, SquareCheck, UserCheck } from "lucide-react-native";
import type { AgentRun } from "../../../../src/agents/types.ts";
import { CHECK_RESULT, type StatusSpec } from "../../../../src/ui/status.ts";
import { confirm } from "../../ui/primitives";
import type { LadderStep } from "../../ui/status";
import { colors, space, text, touch } from "../../ui/theme";
import { ladderState, type ExecutionState } from "./model";

export const EXECUTION: Readonly<Record<ExecutionState, StatusSpec>> = {
  enabled: { tone: "green", icon: LockOpen, label: "Execution enabled" },
  paused: { tone: "amber", icon: Lock, label: "Execution paused" },
  disabled: { tone: "gray", icon: Lock, label: "Execution disabled" },
};

export function Checkbox({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const Icon = checked ? SquareCheck : Square;
  return <Pressable onPress={() => onChange(!checked)} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} accessibilityLabel={label}
    style={({ pressed }) => [styles.box, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon size={22} color={checked ? colors.accent : colors.control} />
    <Text style={[text.body, styles.flex]}>{label}</Text>
  </Pressable>;
}

/** Reported, checked, accepted, shipped: four separate facts (web ladderFor). */
export function ladderFor(run: AgentRun): LadderStep[] {
  const s = ladderState(run);
  const configured = run.checks.length;
  const results = run.packet?.checks ?? [];
  const passing = results.filter((check) => check.exitCode === 0).length;
  const checks: LadderStep = s.checks === "none"
    ? { spec: { tone: "gray", icon: CircleDashed, label: "" }, title: "No automated checks", detail: "Manual review only", state: "todo" }
    : s.checks === "failed" ? { spec: CHECK_RESULT.failed, title: "Checks failed", detail: `${passing} of ${configured} passing`, state: "current" }
    : s.checks === "passed" ? { spec: CHECK_RESULT.passed, title: "Checks passed", detail: `${passing} of ${configured} on this revision`, state: "done" }
    : { spec: CHECK_RESULT["not-run"], title: "Checks not run", detail: `${passing} of ${configured} on this revision`, state: s.reviewing ? "current" : "todo" };
  return [
    s.reported === "done" ? { spec: { tone: "gray", icon: Bot, label: "" }, title: "Agent finished", detail: "Reported, not verified", state: "done" }
      : s.reported === "working" ? { spec: { tone: "blue", icon: Bot, label: "" }, title: "Agent working", detail: "Nothing to review yet", state: "current" }
      : { spec: { tone: "gray", icon: Bot, label: "" }, title: "Agent did not finish", detail: "No result to review", state: "todo" },
    checks,
    s.accepted ? { spec: { tone: "green", icon: UserCheck, label: "" }, title: "You accepted", detail: "Recorded decision", state: "done" }
      : { spec: { tone: s.reviewing ? "amber" : "gray", icon: UserCheck, label: "" }, title: "You accept", detail: s.reviewing ? "Waiting for you" : "Not yet", state: s.reviewing ? "current" : "todo" },
    { spec: { tone: "gray", icon: GitMerge, label: "" }, title: "Merge or deploy", detail: "Separate. Accepting does not do this", state: "separate" },
  ];
}

/** The web's useDraftGuard: leaving with an unsaved draft asks first. Returns a function that lifts the guard before an intended navigation. */
export function useDraftGuard(dirty: boolean): () => void {
  return usePreventRemove(dirty, ({ repeat }) => {
    void confirm({ title: "Discard your draft?", message: "Your unsaved changes on this screen will be lost.", confirmLabel: "Discard", cancelLabel: "Keep editing", destructive: true })
      .then((ok) => { if (ok) repeat(); });
  });
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch },
  flex: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});
