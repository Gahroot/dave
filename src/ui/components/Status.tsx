import type { ReactNode } from "react";
import { ActionIcon, Popover, Text } from "@mantine/core";
import { ChevronDown, CircleHelp } from "lucide-react";
import type { StatusSpec, Tone } from "../status.ts";

/** A colored icon. Decorative unless given a label, because the visible word carries the meaning. */
export function StatusIcon({ spec, size = 16, label }: { spec: StatusSpec; size?: number; label?: string }) {
  const Icon = spec.icon;
  return <span className={`status-icon tone-${spec.tone}${spec.spin ? " is-spinning" : ""}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <Icon size={size} strokeWidth={2} aria-hidden="true" focusable="false" />
  </span>;
}

/** Icon plus word. The standard way to show any domain state. */
export function StatusMark({ spec, children, size = 16, strong = false }: { spec: StatusSpec; children?: ReactNode; size?: number; strong?: boolean }) {
  return <span className={`status-mark${strong ? " is-strong" : ""}`} data-tone={spec.tone}>
    <StatusIcon spec={spec} size={size} /><span className="status-mark-label">{children ?? spec.label}</span>
  </span>;
}

/** A status icon on a soft tile of its own tone: the lead of a row or a section heading. The words beside it carry the meaning. */
export function StatusTile({ spec, size = 16 }: { spec: StatusSpec; size?: number }) {
  return <span className="status-tile" data-tone={spec.tone}><StatusIcon spec={spec} size={size} /></span>;
}

/** A small count. Hidden from assistive tech when the surrounding name already states it. */
export function CountPill({ value, tone, decorative = true }: { value: number; tone?: Tone; decorative?: boolean }) {
  return <span className={`count-pill${tone === "amber" || tone === "red" ? ` is-${tone}` : ""}`} aria-hidden={decorative || undefined}>{value}</span>;
}

/** Long explanations move here, behind a question mark, instead of sitting on the page. */
export function HelpTip({ label, children, width = 320 }: { label: string; children: ReactNode; width?: number }) {
  return <Popover width={width} position="bottom-start" withArrow shadow="md">
    <Popover.Target><ActionIcon variant="subtle" color="gray" size={32} aria-label={label} className="help-tip"><CircleHelp size={16} aria-hidden="true" /></ActionIcon></Popover.Target>
    <Popover.Dropdown><Text size="sm" component="div" className="help-tip-body">{children}</Text></Popover.Dropdown>
  </Popover>;
}

/** A collapsible group: mark, title, count, optional note. Native details keeps keyboard and AT behaviour. */
export function StatusGroup({ spec, title, count, note, open = true, actions, children, id }: {
  spec: StatusSpec; title: string; count: number; note?: ReactNode; open?: boolean; actions?: ReactNode; children: ReactNode; id?: string;
}) {
  return <details className="status-group" data-tone={spec.tone} open={open} id={id}>
    <summary><ChevronDown className="status-group-chevron" size={16} aria-hidden="true" /><StatusIcon spec={spec} /><span className="status-group-title">{title}</span><CountPill value={count} tone={spec.tone} decorative={false} />{note && <span className="status-group-note">{note}</span>}</summary>
    {actions && <div className="status-group-actions">{actions}</div>}
    {children}
  </details>;
}

export type LadderStep = Readonly<{ spec: StatusSpec; title: string; detail: string; state: "done" | "current" | "todo" | "separate" }>;
/** Keeps four facts apart: what the agent reported, what checks proved, what you accepted, what shipped. */
export function TrustLadder({ steps, label = "What has and has not happened" }: { steps: readonly LadderStep[]; label?: string }) {
  return <ol className="trust-ladder" aria-label={label}>{steps.map(step => <li key={step.title} className="trust-step" data-tone={step.spec.tone} data-state={step.state}>
    <StatusIcon spec={step.spec} size={18} />
    <span className="trust-step-title">{step.title}</span>
    <span className="trust-step-detail">{step.detail}</span>
  </li>)}</ol>;
}

/** Compact label/value line with an icon, for property lists like project notes. */
export function PropertyRow({ icon, label, children, action }: { icon: ReactNode; label: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <div className="property-row"><span className="property-icon" aria-hidden="true">{icon}</span><span className="property-label">{label}</span><span className="property-value">{children}</span>{action && <span className="property-action">{action}</span>}</div>;
}
