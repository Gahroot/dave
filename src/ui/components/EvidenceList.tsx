import { List, Text, Tooltip } from "@mantine/core";
import type { EvidenceRef } from "../../shared/types.ts";

/** Shows exactly what was read to produce an inference — never the whole file. */
export function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  if (evidence.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        No evidence recorded
      </Text>
    );
  }
  return (
    <List size="xs" spacing={2} withPadding>
      {evidence.map((e, i) => (
        <List.Item key={i}>
          <Tooltip label={e.path ?? e.kind} multiline w={360}>
            <Text size="xs" c="dimmed">
              <b>{e.kind}</b> — {e.detail}
            </Text>
          </Tooltip>
        </List.Item>
      ))}
    </List>
  );
}
