import { Button, Group, Stack, Text } from "@mantine/core";
import { ArrowRight, CircleCheck } from "lucide-react";
import type { TopAction } from "../top-action.ts";

/** The one answer to "what should I do next?": the action, why it matters, and what finished looks like. */
export function NextBestAction({ action, href }: { action: TopAction | null; href: (action: TopAction) => string }) {
  if (!action) return <section className="next-best-action" aria-label="Next best action"><Group gap="xs"><CircleCheck size={18} aria-hidden="true" /><Text fw={600}>Nothing needs you right now</Text></Group><Text size="sm" c="dimmed">Everything loaded is waiting on someone else or already handled.</Text></section>;
  const reason = action.row && action.row.reason && action.row.reason !== action.title ? ` ${action.row.reason}` : "";
  return <section className="next-best-action" aria-label="Next best action" data-testid="next-best-action" style={{ border: "1px solid var(--mantine-color-gray-4)", borderRadius: 8, padding: "var(--mantine-spacing-md)" }}>
    <Stack gap={6}>
      <Text size="xs" tt="uppercase" fw={700} c="dimmed">Do this next · {action.project}</Text>
      <Text fw={700} size="lg">{action.title}</Text>
      <Text size="sm"><strong>Why it matters:</strong> {action.impact}{reason}</Text>
      <Text size="sm"><strong>Finished when:</strong> {action.done}</Text>
      <Group justify="space-between" mt={4} wrap="wrap">
        <Button component="a" href={href(action)} rightSection={<ArrowRight size={16} aria-hidden="true" />}>Open it</Button>
        {!!action.alsoNext.length && <Text size="xs" c="dimmed">Then: {action.alsoNext.join(" · ")}</Text>}
      </Group>
    </Stack>
  </section>;
}
