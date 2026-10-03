import { useEffect, useState, type ReactNode } from "react";
import { Button, Group, Stack, Title } from "@mantine/core";
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { StatusIcon } from "../components/Status.tsx";
import type { StatusSpec } from "../status.ts";

const DONE: StatusSpec = { tone: "green", icon: CircleCheck, label: "Done" };
const CURRENT: StatusSpec = { tone: "blue", icon: CircleDot, label: "Current" };
const TODO: StatusSpec = { tone: "gray", icon: CircleDashed, label: "To do" };

/** Presentation only: packet approval, revisions and operations remain in DeliveryView. */
export function DeliverySetup({ goal, context, review, hasGoal, hasPlan, canReview, manualOnly }: {
  goal: ReactNode; context: ReactNode; review: ReactNode; hasGoal: boolean; hasPlan: boolean; canReview: boolean; manualOnly: boolean;
}) {
  const [stage, setStage] = useState(0);
  const [open, setOpen] = useState(!hasPlan);
  useEffect(() => { if (hasPlan) setOpen(false); }, [hasPlan]);
  const labels = ["Goal", "Context", "Review and plan"];
  return <details className="quiet-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{hasPlan ? "Edit delivery goal and planning context" : "Set up delivery"}</summary>
    <Stack gap="md" mt="md" className="form-stage">
      <ol className="step-dots" aria-label={`Step ${stage + 1} of 3`}>{labels.map((label, index) => <li key={label} data-state={index < stage ? "done" : index === stage ? "current" : "todo"} aria-current={index === stage ? "step" : undefined}><StatusIcon spec={index < stage ? DONE : index === stage ? CURRENT : TODO} />{label}</li>)}</ol>
      <Title order={3}>{labels[stage]}</Title>
      <div hidden={stage !== 0}>{goal}</div><div hidden={stage !== 1}>{context}</div><div hidden={stage !== 2}>{review}</div>
      <Group className="form-actions" gap="xs">{hasGoal && manualOnly && <Button variant="default" onClick={() => setOpen(false)}>Continue with my coding tool</Button>}<Button variant="subtle" color="dark" leftSection={<ArrowLeft size={16} aria-hidden="true" />} disabled={stage === 0} onClick={() => setStage(s => s - 1)}>Back</Button>{stage < 2 && <Button className="action-primary" rightSection={<ArrowRight size={16} aria-hidden="true" />} disabled={stage === 0 ? !hasGoal : !canReview} onClick={() => setStage(s => s + 1)}>{stage === 0 ? "Continue to context" : "Review and plan"}</Button>}</Group>
    </Stack>
  </details>;
}
