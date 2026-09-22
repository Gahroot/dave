import { useEffect, useState, type ReactNode } from "react";
import { Button, Group, Stack, Text, Title } from "@mantine/core";

/** Presentation only: packet approval, revisions and operations remain in DeliveryView. */
export function DeliverySetup({ goal, context, review, hasGoal, hasPlan, canReview, manualOnly }: {
  goal: ReactNode; context: ReactNode; review: ReactNode; hasGoal: boolean; hasPlan: boolean; canReview: boolean; manualOnly: boolean;
}) {
  const [stage, setStage] = useState(0);
  const [open, setOpen] = useState(!hasPlan);
  useEffect(() => { if (hasPlan) setOpen(false); }, [hasPlan]);
  const labels = ["Goal", "Context", "Review and plan"];
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{hasPlan ? "Edit delivery goal and planning context" : "Set up delivery"}</summary>
    <Stack gap="md" mt="md" className="form-stage">
      <Text size="sm">Step {stage + 1} of 3</Text><Title order={3}>{labels[stage]}</Title>
      <div hidden={stage !== 0}>{goal}</div><div hidden={stage !== 1}>{context}</div><div hidden={stage !== 2}>{review}</div>
      <Group className="form-actions">{hasGoal && manualOnly && <Button onClick={() => setOpen(false)}>Continue with my coding tool</Button>}<Button variant="default" disabled={stage === 0} onClick={() => setStage(s => s - 1)}>Back</Button>{stage < 2 && <Button disabled={stage === 0 ? !hasGoal : !canReview} onClick={() => setStage(s => s + 1)}>{stage === 0 ? "Continue to context" : "Review and plan"}</Button>}</Group>
    </Stack>
  </details>;
}
