import type { ReactNode } from "react";
import { Tooltip } from "@mantine/core";
import { Lightbulb as IconBulb, Pencil as IconPencil, Pin as IconPin, Terminal as IconTerminal2 } from "lucide-react";

/** Quiet tag: a colored icon beside neutral text. No tinted fill, so the text keeps full contrast. */
function QuietTag({ icon, tone, children }: { icon: ReactNode; tone: "blue" | "violet" | "gray" | "green"; children: ReactNode }) {
  return <span className="quiet-tag"><span className={`status-icon tone-${tone}`} aria-hidden="true">{icon}</span>{children}</span>;
}

/**
 * Ordinary git and session activity. Deliberately never called progress: it
 * proves files moved, not that the work advanced.
 */
export function TechnicalActivityBadge({ detail }: { detail?: string }) {
  const why = detail ?? "Observed machine activity: commits, sessions, task updates";
  // Focusable so keyboard users can open the explanation; the label carries it for screen readers.
  return (
    <Tooltip label={why} multiline w={300}>
      <span tabIndex={0} role="note" aria-label={`Technical activity. ${why}`}><QuietTag tone="gray" icon={<IconTerminal2 size={12} />}>Technical activity</QuietTag></span>
    </Tooltip>
  );
}

/** An inferred next step. Shown as a suggestion, never as an instruction. */
export function SuggestionBadge({ detail }: { detail?: string }) {
  return (
    <Tooltip label={detail ?? "Inferred from the evidence: a suggestion, not a fact"} multiline w={300}>
      <span tabIndex={0} role="note" aria-label={`Suggestion. ${detail ?? "Inferred from the evidence: a suggestion, not a fact"}`}><QuietTag tone="violet" icon={<IconBulb size={12} />}>Suggestion</QuietTag></span>
    </Tooltip>
  );
}

export function EditedBadge() {
  return (
    <Tooltip label="You corrected this summary; it will not be overwritten">
      <span tabIndex={0} role="note" aria-label="Your edit. You corrected this summary; it will not be overwritten"><QuietTag tone="green" icon={<IconPencil size={12} />}>Your edit</QuietTag></span>
    </Tooltip>
  );
}

export function PinnedBadge() {
  return <QuietTag tone="blue" icon={<IconPin size={12} />}>Pinned</QuietTag>;
}
