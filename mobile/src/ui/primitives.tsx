/**
 * Shared building blocks for every phone screen. Mirrors the web workbench:
 * a soft canvas, one white panel per section (panels never nest), rows with a
 * status tile lead, one filled primary action per decision region.
 *
 * Feature code composes these; add feature-specific pieces inside
 * `src/features/<area>/`, not here.
 */
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Check, ChevronDown, ChevronRight, Copy, Inbox, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { colors, radius, rail, railTones, shadow, space, text, tints, tones, touch } from "./theme";
import { CountPill, StatusTile, type StatusSpec, type Tone } from "./status";

// ── Layout ─────────────────────────────────────────────────────────────────

/**
 * A scrolling screen on the canvas. Pass `onRefresh` for pull-to-refresh.
 * Use `scroll={false}` when the child is itself a list (FlatList/SectionList).
 */
export function Screen({ children, refreshing = false, onRefresh, scroll = true, style }: {
  children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean; style?: StyleProp<ViewStyle>;
}) {
  if (!scroll) return <View style={[styles.canvas, style]}>{children}</View>;
  return <ScrollView style={styles.canvas} contentContainerStyle={[styles.content, style]} keyboardShouldPersistTaps="handled"
    refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} /> : undefined}>
    {children}
  </ScrollView>;
}

/** Full-bleed screen respecting safe areas (for screens without a navigation header). */
export function SafeScreen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <SafeAreaView style={[styles.canvas, style]} edges={["top", "left", "right"]}>{children}</SafeAreaView>;
}

/** Bottom padding that clears the home indicator, for the end of long forms. */
export function BottomSpacer() {
  const insets = useSafeAreaInsets();
  return <View style={{ height: Math.max(insets.bottom, space.lg) + space.lg }} />;
}

/** One white section. Header: optional tone tile, title, count, note and actions. */
export function Panel({ title, spec, count, note, actions, children, tone, padded = true, style }: {
  title?: string; spec?: StatusSpec; count?: number; note?: ReactNode; actions?: ReactNode; children?: ReactNode;
  /** Washes the panel in a tone tint, e.g. the amber "Do this next" panel. */
  tone?: Tone; padded?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.panel, tone && { backgroundColor: tints[tone], borderColor: tints[tone] }, style]}>
    {(title || actions) && <View style={styles.panelHead}>
      {spec && <StatusTile spec={spec} />}
      <View style={styles.panelTitle}>
        {title && <View style={styles.inline}><Text style={[text.subheading, styles.shrink]} accessibilityRole="header">{title}</Text>{count !== undefined && <CountPill value={count} tone={spec?.tone} />}</View>}
        {typeof note === "string" ? <Text style={text.caption}>{note}</Text> : note}
      </View>
      {actions}
    </View>}
    <View style={padded ? styles.panelBody : undefined}>{children}</View>
  </View>;
}

/**
 * A list row: status tile lead, title, subtitle, optional aside and chevron.
 * Amber/red/violet rows get a 3px rail (railTones); calm rows never do.
 */
export function Row({ title, subtitle, spec, onPress, right, children, selected = false, showRail = true, accessibilityLabel, accessibilityHint }: {
  title: string; subtitle?: ReactNode; spec?: StatusSpec; onPress?: () => void; right?: ReactNode; children?: ReactNode;
  selected?: boolean; showRail?: boolean; accessibilityLabel?: string; accessibilityHint?: string;
}) {
  const railed = showRail && spec && railTones.has(spec.tone);
  const body = <>
    {spec && <StatusTile spec={spec} />}
    <View style={styles.flex}>
      <Text style={[text.body, styles.rowTitle, selected && styles.bold]} numberOfLines={3}>{title}</Text>
      {typeof subtitle === "string" ? <Text style={text.muted} numberOfLines={3}>{subtitle}</Text> : subtitle}
      {children}
    </View>
    {right}
    {onPress && <ChevronRight size={18} color={colors.control} />}
  </>;
  const style = [styles.row, railed && spec && { borderLeftWidth: rail, borderLeftColor: tones[spec.tone], paddingLeft: space.md - rail }, selected && { backgroundColor: colors.selected }];
  if (!onPress) return <View style={style}>{body}</View>;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={accessibilityHint}
    style={({ pressed }) => [...style, pressed && styles.pressed]}>{body}</Pressable>;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export function Stack({ children, gap = space.md, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

export function Inline({ children, gap = space.sm, wrap = true, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.inline, { gap, flexWrap: wrap ? "wrap" : "nowrap" }, style]}>{children}</View>;
}

// ── Text ───────────────────────────────────────────────────────────────────

export function Title({ children }: { children: ReactNode }) {
  return <Text style={text.title} accessibilityRole="header">{children}</Text>;
}
export function Heading({ children }: { children: ReactNode }) {
  return <Text style={text.heading} accessibilityRole="header">{children}</Text>;
}
export function Body({ children, strong = false, selectable = false, numberOfLines }: { children: ReactNode; strong?: boolean; selectable?: boolean; numberOfLines?: number }) {
  return <Text style={[text.body, strong && styles.bold]} selectable={selectable} numberOfLines={numberOfLines}>{children}</Text>;
}
export function Small({ children, strong = false, selectable = false }: { children: ReactNode; strong?: boolean; selectable?: boolean }) {
  return <Text style={[text.small, strong && styles.bold]} selectable={selectable}>{children}</Text>;
}
export function Muted({ children, selectable = false, numberOfLines }: { children: ReactNode; selectable?: boolean; numberOfLines?: number }) {
  return <Text style={text.muted} selectable={selectable} numberOfLines={numberOfLines}>{children}</Text>;
}
export function Caption({ children }: { children: ReactNode }) {
  return <Text style={text.caption}>{children}</Text>;
}
/** Monospace block for commands, paths, JSON and diffs. Selectable. */
export function Code({ children }: { children: string }) {
  return <ScrollView horizontal style={styles.code} contentContainerStyle={styles.codeContent}><Text style={text.mono} selectable>{children}</Text></ScrollView>;
}
/** Label/value line for property lists. */
export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <View style={styles.keyValue}><Text style={[text.caption, styles.keyLabel]}>{label}</Text>{typeof children === "string" ? <Text style={[text.small, styles.flex]} selectable>{children}</Text> : <View style={styles.flex}>{children}</View>}</View>;
}

// ── Actions ────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "subtle" | "danger" | "danger-subtle";

/** One filled primary per decision region; secondary outlined; subtle for tertiary; danger for destructive. */
export function Button({ title, onPress, variant = "secondary", icon: Icon, loading = false, disabled = false, accessibilityLabel, accessibilityHint, compact = false, style }: {
  title: string; onPress: () => void; variant?: ButtonVariant; icon?: LucideIcon; loading?: boolean; disabled?: boolean;
  accessibilityLabel?: string; accessibilityHint?: string; compact?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const palette = BUTTON[variant];
  const inactive = disabled || loading;
  return <Pressable onPress={onPress} disabled={inactive} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
    accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }}
    style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor: palette.bg, borderColor: palette.border }, inactive && styles.disabled, pressed && styles.pressed, style]}>
    {loading ? <ActivityIndicator size="small" color={palette.fg} /> : Icon ? <Icon size={16} color={palette.fg} /> : null}
    <Text style={[styles.buttonText, { color: palette.fg }]} numberOfLines={2}>{title}</Text>
  </Pressable>;
}
const BUTTON: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
  secondary: { bg: colors.surface, fg: colors.ink, border: colors.border },
  subtle: { bg: "transparent", fg: colors.accent, border: "transparent" },
  danger: { bg: colors.danger, fg: colors.onDanger, border: colors.danger },
  "danger-subtle": { bg: "transparent", fg: colors.danger, border: "transparent" },
};

/** Square 44pt icon-only button; always pass an accessible label. */
export function IconButton({ icon: Icon, label, onPress, disabled = false, color = colors.ink }: { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean; color?: string }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}
    style={({ pressed }) => [styles.iconButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon size={20} color={color} />
  </Pressable>;
}

/** Copies text with haptic + visible confirmation ("Copied"). */
export function CopyButton({ text: value, label = "Copy", variant = "secondary", compact = true }: { text: string; label?: string; variant?: ButtonVariant; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <Button title={copied ? "Copied" : label} icon={copied ? Check : Copy} variant={variant} compact={compact}
    accessibilityLabel={copied ? `${label}: copied` : label}
    onPress={() => { void Clipboard.setStringAsync(value).then(() => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} />;
}

/**
 * Native confirmation. Resolves true only on the confirm button.
 *   if (await confirm({ title: "Disconnect OpenAI?", message: "…", confirmLabel: "Disconnect", destructive: true })) …
 */
export function confirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false }: {
  title: string; message?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Light haptic tick for completed actions. */
export function tick(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

// ── Feedback states ────────────────────────────────────────────────────────

/** Inline alert. Red for failures, amber for your move, blue for info, green for success. */
export function Banner({ tone = "blue", title, message, action }: { tone?: Tone; title: string; message?: ReactNode; action?: ReactNode }) {
  return <View style={[styles.banner, { borderLeftColor: tones[tone], backgroundColor: tints[tone] }]} accessibilityRole={tone === "red" ? "alert" : "summary"}>
    <Text style={[text.small, styles.bold]}>{title}</Text>
    {typeof message === "string" ? <Text style={text.small}>{message}</Text> : message}
    {action}
  </View>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}><ActivityIndicator color={colors.accent} /><Text style={text.muted}>{label}</Text></View>;
}

export function ErrorState({ message, onRetry, title = "Couldn't load this" }: { message: string; onRetry?: () => void; title?: string }) {
  return <View style={styles.center}>
    <TriangleAlert size={28} color={tones.red} />
    <Text style={[text.subheading, styles.centerText]}>{title}</Text>
    <Text style={[text.muted, styles.centerText]}>{message}</Text>
    {onRetry && <Button title="Retry" icon={RefreshCw} onPress={onRetry} />}
  </View>;
}

/** A quiet state is valid: say so plainly and offer the one useful next step. */
export function EmptyState({ title, message, icon: Icon = Inbox, action }: { title: string; message?: string; icon?: LucideIcon; action?: ReactNode }) {
  return <View style={styles.empty}>
    <View style={styles.emptyIcon}><Icon size={20} color={tones.gray} /></View>
    <Text style={text.subheading}>{title}</Text>
    {message && <Text style={text.muted}>{message}</Text>}
    {action}
  </View>;
}

// ── Inputs ─────────────────────────────────────────────────────────────────

export function TextField({ label, help, error, style, ...input }: TextInputProps & { label: string; help?: string; error?: string | null }) {
  return <View style={styles.field}>
    <Text style={[text.small, styles.bold]}>{label}</Text>
    <TextInput placeholderTextColor={colors.control} accessibilityLabel={label} accessibilityHint={help}
      style={[styles.input, input.multiline && styles.inputMultiline, error ? { borderColor: tones.red } : null, style]} {...input} />
    {error ? <Text style={[text.caption, { color: tones.red }]}>{error}</Text> : help ? <Text style={text.caption}>{help}</Text> : null}
  </View>;
}

export function Toggle({ label, value, onValueChange, help, disabled = false }: { label: string; value: boolean; onValueChange: (next: boolean) => void; help?: string; disabled?: boolean }) {
  return <View style={styles.toggle}>
    <View style={styles.flex}><Text style={text.body}>{label}</Text>{help && <Text style={text.caption}>{help}</Text>}</View>
    <Switch value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={label} trackColor={{ true: colors.accent, false: colors.border }} />
  </View>;
}

export type SegmentOption<T extends string> = { value: T; label: string; count?: number; tone?: Tone };
/** Tabs/filters. Horizontal scroll when they do not fit. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly SegmentOption<T>[]; value: T; onChange: (next: T) => void; label?: string }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel={label} contentContainerStyle={styles.segments}>
    {options.map((option) => {
      const active = option.value === value;
      return <Pressable key={option.value} onPress={() => onChange(option.value)} accessibilityRole="tab" accessibilityState={{ selected: active }}
        accessibilityLabel={option.count ? `${option.label}, ${option.count}` : option.label}
        style={[styles.segment, active && styles.segmentActive]}>
        <Text style={[text.small, active && styles.bold]}>{option.label}</Text>
        {option.count !== undefined && <CountPill value={option.count} tone={option.tone} />}
      </Pressable>;
    })}
  </ScrollView>;
}

export type SelectOption<T extends string> = { value: T; label: string; help?: string };
/** A labelled picker that opens a sheet of options. */
export function SelectField<T extends string>({ label, value, options, onChange, help, disabled = false, placeholder = "Choose…" }: {
  label: string; value: T | null; options: readonly SelectOption<T>[]; onChange: (next: T) => void; help?: string; disabled?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return <View style={styles.field}>
    <Text style={[text.small, styles.bold]}>{label}</Text>
    <Pressable onPress={() => setOpen(true)} disabled={disabled} accessibilityRole="button" accessibilityLabel={`${label}: ${current?.label ?? placeholder}`}
      style={[styles.input, styles.select, disabled && styles.disabled]}>
      <Text style={[text.body, styles.flex, !current && { color: colors.control }]} numberOfLines={1}>{current?.label ?? placeholder}</Text>
      <ChevronDown size={18} color={colors.control} />
    </Pressable>
    {help && <Text style={text.caption}>{help}</Text>}
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <Text style={[text.subheading, styles.sheetTitle]}>{label}</Text>
        <FlatList data={options as SelectOption<T>[]} keyExtractor={(o) => o.value} renderItem={({ item }) =>
          <Pressable onPress={() => { onChange(item.value); setOpen(false); }} accessibilityRole="button" accessibilityState={{ selected: item.value === value }}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
            <View style={styles.flex}><Text style={[text.body, item.value === value && styles.bold]}>{item.label}</Text>{item.help && <Text style={text.caption}>{item.help}</Text>}</View>
            {item.value === value && <Check size={18} color={colors.accent} />}
          </Pressable>} />
        <BottomSpacer />
      </View>
    </Modal>
  </View>;
}

/** Collapsible group (the web's <details>). */
export function Disclosure({ title, count, spec, defaultOpen = false, children }: { title: string; count?: number; spec?: StatusSpec; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <View>
    <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.disclosure}>
      {open ? <ChevronDown size={16} color={colors.muted} /> : <ChevronRight size={16} color={colors.muted} />}
      {spec && <StatusTile spec={spec} size={14} />}
      <Text style={[text.small, styles.bold, styles.flex]}>{title}</Text>
      {count !== undefined && <CountPill value={count} tone={spec?.tone} />}
    </Pressable>
    {open && <View style={styles.disclosureBody}>{children}</View>}
  </View>;
}

/** Quiet tag (no tinted fill) for secondary labels. */
export function Tag({ children, tone }: { children: string; tone?: Tone }) {
  return <View style={[styles.tag, tone && { borderColor: tones[tone] }]}><Text style={text.caption}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: colors.canvas },
  // Bottom room so the last controls can scroll clear of the floating Talk to DAVE button.
  content: { padding: space.lg, gap: space.lg, paddingBottom: 120 },
  flex: { flex: 1, minWidth: 0 },
  inline: { flexDirection: "row", alignItems: "center", gap: space.sm },
  bold: { fontWeight: "600" },
  panel: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.panelBorder, overflow: "hidden", ...shadow },
  // Wraps: header actions drop below the title instead of squeezing it on narrow phones.
  panelHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  panelTitle: { flexGrow: 1, flexShrink: 1, flexBasis: 180 },
  shrink: { flexShrink: 1 },
  panelBody: { padding: space.lg, paddingTop: space.sm, gap: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingHorizontal: space.md, minHeight: touch, backgroundColor: colors.surface },
  rowTitle: { fontWeight: "500" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  code: { backgroundColor: colors.sunken, borderRadius: radius.sm, maxHeight: 320 },
  codeContent: { padding: space.sm },
  keyValue: { flexDirection: "row", gap: space.md, alignItems: "flex-start", paddingVertical: space.xs },
  keyLabel: { width: 110, paddingTop: 2 },
  button: { minHeight: touch, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  buttonCompact: { minHeight: 36, paddingHorizontal: space.md },
  buttonText: { fontSize: 15, fontWeight: "600", textAlign: "center", flexShrink: 1 },
  iconButton: { width: touch, height: touch, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  banner: { borderLeftWidth: rail, borderRadius: radius.md, padding: space.md, gap: space.xs },
  center: { alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl, minHeight: 200 },
  centerText: { textAlign: "center" },
  empty: { gap: space.sm, paddingVertical: space.xl, alignItems: "flex-start" },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderStyle: "dashed", borderColor: colors.control, alignItems: "center", justifyContent: "center" },
  field: { gap: space.xs },
  input: { minHeight: touch, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  inputMultiline: { minHeight: 110, textAlignVertical: "top" },
  select: { flexDirection: "row", alignItems: "center", gap: space.sm },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch },
  segments: { gap: space.xs, paddingVertical: space.xxs },
  segment: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  segmentActive: { backgroundColor: colors.selected, borderColor: colors.control },
  backdrop: { flex: 1, backgroundColor: "rgba(15,20,30,0.35)" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: "70%", paddingTop: space.md },
  sheetTitle: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch, paddingHorizontal: space.lg, paddingVertical: space.sm },
  disclosure: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch },
  disclosureBody: { gap: space.sm, paddingBottom: space.sm },
  tag: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space.xs + 2, paddingVertical: 1 },
});
