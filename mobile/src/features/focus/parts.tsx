/** Shared Focus pieces: marks, provenance, plan rows, meters and the copy-then-mark-sent button. */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Check, ChevronDown, ChevronRight, CircleDashed, Copy, Square } from "lucide-react-native";
import type { Basis, Blocker, DeliveryProgress, EvidenceState, Freshness, Provenance, ReadinessLevel } from "../../../../src/intel/types.ts";
import {
  STEP_GOAL, agoLabel, behindBand, blockerOwnerText, evidenceFreshness, progressLine, readinessCells, stepCells, stepLabel,
} from "../../../../src/ui/focus-model.ts";
import { BASIS, DELIVERY_FRESHNESS, DELIVERY_STEP, EVIDENCE_STATE, READINESS_LEVEL } from "../../../../src/ui/status.ts";
import { Button, Inline, Muted, Small, Stack, tick, type ButtonVariant } from "../../ui/primitives";
import { CountPill, StatusIcon, StatusMark, type StatusSpec, type Tone } from "../../ui/status";
import { colors, radius, rail, space, text, tints, tones, touch } from "../../ui/theme";
import { linkRoute } from "./model";

export function FreshnessMark({ freshness }: { freshness: Freshness }) { return <StatusMark spec={DELIVERY_FRESHNESS[freshness]} />; }
export function BasisMark({ basis }: { basis: Basis }) { return <StatusMark spec={BASIS[basis]} />; }
export function EvidenceMark({ state }: { state: EvidenceState }) { return <StatusMark spec={EVIDENCE_STATE[state]} />; }

/** The four readiness levels, each on its own line so none reads as "done" for the others. */
export function ReadinessStrip({ reached }: { reached: ReadinessLevel | null }) {
  return <View accessibilityLabel="Readiness, four separate facts" style={styles.wrapRow}>
    {readinessCells(reached).map(c => <View key={c.level} accessibilityLabel={`${READINESS_LEVEL[c.level].label}: ${c.reached ? "evidenced" : "not evidenced"}`}>
      <StatusMark size={14} spec={c.reached ? READINESS_LEVEL[c.level] : { ...READINESS_LEVEL[c.level], tone: "gray", icon: EVIDENCE_STATE.not_implemented.icon }}>
        {READINESS_LEVEL[c.level].label}
      </StatusMark>
    </View>)}
  </View>;
}

/** Source, quote, freshness, confidence, link. Untrusted text is plain selectable Text. */
export function ProvenanceList({ items, now }: { items: readonly Provenance[]; now: number }) {
  const router = useRouter();
  if (!items.length) return <Muted>No supporting evidence recorded. Treat this as unconfirmed.</Muted>;
  return <Stack gap={space.sm}>
    {items.map((p, i) => {
      const route = linkRoute(p.link);
      return <View key={`${p.sourceKind}-${p.sourceId ?? ""}-${i}`} style={styles.provenance}>
        <Inline>
          {route
            ? <Pressable accessibilityRole="link" onPress={() => router.push(route)} style={styles.link}><Text style={[text.small, styles.bold, { color: colors.accent }]}>{p.label}</Text></Pressable>
            : <Text style={[text.small, styles.bold]} selectable>{p.label}</Text>}
          <Text style={text.caption}>{p.sourceKind.replace(/-/g, " ")}</Text>
        </Inline>
        {p.quote && <View style={styles.quote}><Text style={text.small} selectable>{p.quote}</Text></View>}
        <Inline gap={space.md}><FreshnessMark freshness={evidenceFreshness(p.observedAt, now)} /><Small>Observed {agoLabel(p.observedAt, now)}</Small><Small>{p.confidence} confidence</Small></Inline>
      </View>;
    })}
  </Stack>;
}

export function BlockerList({ blockers }: { blockers: readonly Blocker[] }) {
  if (!blockers.length) return <Muted>Nothing blocks this.</Muted>;
  return <Stack gap={space.xs}>{blockers.map((b, i) => <Small key={`${b.itemId ?? "b"}-${i}`} selectable>• {blockerOwnerText(b)}</Small>)}</Stack>;
}

/** Inline failure with a dismiss/retry button (the web's ErrorLine). */
export function ErrorLine({ message, onRetry, label = "Retry" }: { message: string; onRetry: () => void; label?: string }) {
  return <View style={[styles.feedback, { borderLeftColor: tones.red, backgroundColor: tints.red }]} accessibilityRole="alert">
    <Text style={text.small} selectable>{message}</Text>
    <Button title={label} compact onPress={onRetry} style={styles.alignStart} />
  </View>;
}

/** Status line with an action (pending updates, sent/undo). */
export function FeedbackLine({ message, children, tone = "blue" }: { message: string; children?: ReactNode; tone?: Tone }) {
  return <View style={[styles.feedback, { borderLeftColor: tones[tone], backgroundColor: tints[tone] }]} accessibilityRole="summary" accessibilityLiveRegion="polite">
    <Text style={text.small}>{message}</Text>
    {children && <Inline>{children}</Inline>}
  </View>;
}

/** One row anatomy for moves, tasks, extras and decisions: lead, bold title, muted line, actions, then more. */
export function PlanRow({ tone, lead, title, sub, actions, more }: {
  tone?: Tone; lead: ReactNode; title: string; sub?: ReactNode; actions?: ReactNode; more?: ReactNode;
}) {
  const railed = tone === "red" || tone === "violet" || tone === "amber";
  return <View style={[styles.planRow, railed && tone && { borderLeftWidth: rail, borderLeftColor: tones[tone], paddingLeft: space.sm }]}>
    <View style={styles.planHead}>
      {lead}
      <View style={styles.flex}>
        <Text style={[text.body, styles.medium]} selectable>{title}</Text>
        {typeof sub === "string" ? <Muted selectable>{sub}</Muted> : sub}
      </View>
    </View>
    {actions && <Inline>{actions}</Inline>}
    {more}
  </View>;
}

/** "Decide · why" line with the kind word. */
export function KindLine({ spec, children }: { spec: StatusSpec; children?: ReactNode }) {
  return <Text style={text.muted} selectable><Text style={styles.bold}>{spec.label}</Text>{children ? <> · {children}</> : null}</Text>;
}

/** A numbered lead tile (rank or task order). */
export function NumberTile({ n, tone }: { n: number; tone?: Tone }) {
  return <View style={[styles.num, tone && { backgroundColor: tints[tone], borderColor: tones[tone] }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
    <Text style={[text.small, styles.bold]}>{n}</Text>
  </View>;
}

export function Checklist({ lines }: { lines: readonly string[] }) {
  return <Stack gap={space.xxs}>{lines.map((d, i) => <View key={i} style={styles.check}><Square size={14} color={colors.control} /><Text style={[text.small, styles.flex]} selectable>{d}</Text></View>)}</Stack>;
}

/** Verified share as words and a bar. The words carry the meaning; the bar only repeats it. */
export function DoneMeter({ progress }: { progress: DeliveryProgress }) {
  const pct = Math.max(0, Math.min(100, progress.percentDone));
  return <View style={styles.meter}>
    <Small>{progressLine(progress)}</Small>
    <View style={styles.bar} importantForAccessibility="no-hide-descendants"><View style={[styles.barFill, { width: `${pct}%` }]} /></View>
  </View>;
}

/** The behind score as a numeric badge plus band word (the web's ring). */
export function BehindBadge({ score }: { score: number }) {
  const band = behindBand(score);
  return <View style={[styles.badge, { borderColor: tones[band.tone], backgroundColor: tints[band.tone] }]}
    accessible accessibilityLabel={`Behind score ${score} of 100, ${band.label.toLowerCase()}`}>
    <Text style={[text.subheading, { color: colors.ink }]}>{score}</Text>
    <Text style={text.caption}>{band.label}</Text>
  </View>;
}

/** Four separate marks: reaching a later step never claims an earlier one. */
export function StepStrip({ progress }: { progress: DeliveryProgress }) {
  return <View accessibilityLabel={`Delivery steps. ${stepLabel(progress)}`} style={styles.steps}>
    {stepCells(progress).map((c, i) => {
      const spec: StatusSpec = c.reached ? DELIVERY_STEP[c.step] : { ...DELIVERY_STEP[c.step], tone: c.current ? "amber" : "gray", icon: CircleDashed };
      return <View key={c.step} style={[styles.step, { borderTopColor: c.reached ? tones.green : c.current ? tones.amber : colors.border }]}>
        <Inline gap={space.xs}><StatusIcon spec={spec} size={14} /><Text style={[text.small, styles.bold]}>{i + 1}. {DELIVERY_STEP[c.step].label}</Text></Inline>
        <Text style={text.caption}>{c.reached ? "Reached" : c.current ? `Next: ${STEP_GOAL[c.step].toLowerCase()}` : "Not yet"}</Text>
      </View>;
    })}
  </View>;
}

/**
 * Copies text, then reports it (copying a task marks it sent). If the clipboard fails, the text is shown
 * selectable and "Mark as sent" records it after copying by hand.
 */
export function CopyAndSend({ text: value, label, onCopied, onMarkSent, disabled = false, loading = false, variant = "secondary" }: {
  text: string; label: string; onCopied?: () => void; onMarkSent?: () => void; disabled?: boolean; loading?: boolean; variant?: ButtonVariant;
}) {
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(value).then(ok => {
      if (ok === false) { setFailed(true); return; }
      setFailed(false); tick(); setCopied(true); setTimeout(() => setCopied(false), 1500);
      onCopied?.();
    }, () => setFailed(true));
  };
  return <Stack gap={space.xs}>
    <Button title={copied ? "Copied" : label} icon={copied ? Check : Copy} variant={variant} compact disabled={disabled} loading={loading} onPress={copy} />
    {failed && <>
      <Muted>Couldn't copy. Select the text below and copy it yourself.</Muted>
      <View style={styles.quote}><Text style={text.mono} selectable>{value}</Text></View>
      {onMarkSent && <Button title="Mark as sent" compact disabled={disabled} loading={loading} onPress={onMarkSent} />}
    </>}
  </Stack>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  alignStart: { alignSelf: "flex-start" },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  provenance: { gap: space.xs },
  link: { minHeight: 32, justifyContent: "center" },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm, paddingVertical: space.xxs, backgroundColor: colors.sunken, borderRadius: radius.sm },
  feedback: { borderLeftWidth: rail, borderRadius: radius.md, padding: space.md, gap: space.sm },
  planRow: { gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  planHead: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  num: { width: 28, height: 28, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.sunken },
  check: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  meter: { gap: space.xs },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.selected, overflow: "hidden" },
  barFill: { height: 6, backgroundColor: colors.accent },
  badge: { minWidth: touch + 12, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1, alignItems: "center" },
  steps: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  step: { borderTopWidth: 3, paddingTop: space.xs, gap: space.xxs, flexBasis: "47%", flexGrow: 1 },
});

/** A disclosure whose open state the screen controls (reveal opens it). */
export function OpenableSection({ title, count, spec, open, onToggle, children }: {
  title: string; count?: number; spec?: StatusSpec; open: boolean; onToggle: (next: boolean) => void; children: ReactNode;
}) {
  return <View>
    <Pressable onPress={() => onToggle(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={sectionStyles.head}>
      {open ? <ChevronDown size={16} color={colors.muted} /> : <ChevronRight size={16} color={colors.muted} />}
      {spec && <StatusIcon spec={spec} size={14} />}
      <Text style={[text.subheading, sectionStyles.flex]} accessibilityRole="header">{title}</Text>
      {count !== undefined && <CountPill value={count} tone={spec?.tone} />}
    </Pressable>
    {open && <View style={sectionStyles.body}>{children}</View>}
  </View>;
}
const sectionStyles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch },
  flex: { flex: 1, minWidth: 0 },
  body: { gap: space.md, paddingBottom: space.sm },
});
