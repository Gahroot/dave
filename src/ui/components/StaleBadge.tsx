import { Badge, Tooltip } from "@mantine/core";
import { ClockAlert as IconClockExclamation } from "lucide-react";

export function StaleBadge({ label, why }: { label: string; why: string }) {
  return (
    <Tooltip label={why}>
      <Badge
        size="xs"
        color="yellow"
        variant="light"
        leftSection={<IconClockExclamation size={12} />}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
