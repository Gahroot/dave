import type { ReactNode } from "react";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { ChevronLeft, Inbox } from "lucide-react";
import type { StatusSpec, Tone } from "../status.ts";
import { CountPill, StatusTile } from "./Status.tsx";

/** The heading strip of a panel: tone tile, title, count, an optional note and actions on the right. */
export function PanelHead({ id, title, spec, count, countTone, note, help, actions }: {
  id: string; title: string; spec: StatusSpec; count?: number; countTone?: Tone; note?: ReactNode; help?: ReactNode; actions?: ReactNode;
}) {
  return <div className="panel-head">
    <StatusTile spec={spec} />
    <div className="panel-head-text">
      <div className="panel-head-title"><Title order={2} id={id}>{title}</Title>{count !== undefined && <CountPill value={count} tone={countTone} decorative={false} />}{help}</div>
      {note && <Text size="sm" c="dimmed" className="panel-head-note">{note}</Text>}
    </div>
    {actions && <div className="panel-head-actions">{actions}</div>}
  </div>;
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return <header className="page-header"><Group justify="space-between" align="flex-start"><Title order={1}>{title}</Title>{actions}</Group>{children}</header>;
}
export function DetailHeader({ title, back, backLabel, children }: { title: string; back: string; backLabel: string; children?: ReactNode }) {
  return <header className="detail-header"><Button component="a" variant="subtle" color="dark" leftSection={<ChevronLeft size={16} aria-hidden="true" />} href={back} data-workspace-back>{backLabel}</Button><Group justify="space-between" align="flex-start"><Title order={1} tabIndex={-1} data-workspace-heading>{title}</Title>{children}</Group></header>;
}
export function NextActionRow({ title, state, children, action }: { title: ReactNode; state?: string; children?: ReactNode; action?: ReactNode }) {
  return <section className="next-action-row" aria-label="Next action"><Group justify="space-between" align="flex-start"><Stack gap={4}>{state && <Text size="sm" c="dimmed">{state}</Text>}<div>{title}</div>{children}</Stack>{action}</Group></section>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <section className="empty-state"><span className="empty-state-icon" aria-hidden="true"><Inbox size={24} /></span><Title order={3}>{title}</Title>{children && <Text c="dimmed">{children}</Text>}{action}</section>;
}
