import { Badge, Tooltip } from "@mantine/core";
import { IconBulb, IconPencil, IconPin, IconTerminal2 } from "@tabler/icons-react";

/**
 * Ordinary git and session activity. Deliberately never called progress: it
 * proves files moved, not that the work advanced.
 */
export function TechnicalActivityBadge({ detail }: { detail?: string }) {
  return (
    <Tooltip label={detail ?? "Observed machine activity — commits, sessions, task updates"} multiline w={300}>
      <Badge size="xs" color="gray" variant="outline" leftSection={<IconTerminal2 size={11} />}>
        Technical activity
      </Badge>
    </Tooltip>
  );
}

/** An inferred next step. Shown as a suggestion, never as an instruction. */
export function SuggestionBadge({ detail }: { detail?: string }) {
  return (
    <Tooltip label={detail ?? "Inferred from the evidence — a suggestion, not a fact"} multiline w={300}>
      <Badge size="xs" color="violet" variant="light" leftSection={<IconBulb size={11} />}>
        Suggestion
      </Badge>
    </Tooltip>
  );
}

export function EditedBadge() {
  return (
    <Tooltip label="You corrected this summary; it will not be overwritten">
      <Badge size="xs" color="teal" variant="light" leftSection={<IconPencil size={11} />}>
        Your edit
      </Badge>
    </Tooltip>
  );
}

export function PinnedBadge() {
  return (
    <Badge size="xs" color="blue" variant="light" leftSection={<IconPin size={11} />}>
      Pinned
    </Badge>
  );
}
