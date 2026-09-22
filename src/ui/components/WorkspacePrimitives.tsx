import type { ReactNode } from "react";
import { Group, Stack, Text, Title } from "@mantine/core";

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return <header className="page-header"><Group justify="space-between" align="flex-start"><Title order={1}>{title}</Title>{actions}</Group>{children}</header>;
}
export function NextActionRow({ title, state, children, action }: { title: ReactNode; state?: string; children?: ReactNode; action?: ReactNode }) {
  return <section className="next-action-row" aria-label="Next action"><Group justify="space-between" align="flex-start"><Stack gap={4}>{state && <Text size="sm" c="dimmed">{state}</Text>}<div>{title}</div>{children}</Stack>{action}</Group></section>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <section className="empty-state"><Title order={3}>{title}</Title>{children && <Text c="dimmed">{children}</Text>}{action}</section>;
}
