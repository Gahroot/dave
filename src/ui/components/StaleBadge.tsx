import { Tooltip } from "@mantine/core";
import { ClockAlert as IconClockExclamation } from "lucide-react";

/** Out-of-date data: amber clock, neutral text. The reason sits in the tooltip. */
export function StaleBadge({ label, why }: { label: string; why: string }) {
  return (
    <Tooltip label={why} multiline w={300}>
      <span className="quiet-tag" tabIndex={0}>
        <span className="status-icon tone-amber" aria-hidden="true"><IconClockExclamation size={12} /></span>
        {label}
      </span>
    </Tooltip>
  );
}
