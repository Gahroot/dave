/** Port of src/ui/sections/DeliverySetup.tsx: presentation only; approval and revisions stay in the panel. */
import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleDot } from "lucide-react-native";
import { Button, Heading, Inline, Panel, Stack } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";

const DONE: StatusSpec = { tone: "green", icon: CircleCheck, label: "Done" };
const CURRENT: StatusSpec = { tone: "blue", icon: CircleDot, label: "Current" };
const TODO: StatusSpec = { tone: "gray", icon: CircleDashed, label: "To do" };
const LABELS = ["Goal", "Context", "Review and plan"] as const;

export function DeliverySetup({ goal, context, review, hasGoal, hasPlan, canReview, manualOnly }: {
  goal: ReactNode; context: ReactNode; review: ReactNode; hasGoal: boolean; hasPlan: boolean; canReview: boolean; manualOnly: boolean;
}) {
  const [stage, setStage] = useState(0);
  const [open, setOpen] = useState(!hasPlan);
  useEffect(() => { if (hasPlan) setOpen(false); }, [hasPlan]);
  const title = hasPlan ? "Edit delivery goal and planning context" : "Set up delivery";
  return <Panel title={title} actions={<Button title={open ? "Hide" : "Show"} variant="subtle" compact accessibilityLabel={`${open ? "Hide" : "Show"} ${title}`} onPress={() => setOpen(!open)} />}>
    {open && <Stack>
      <View accessibilityLabel={`Step ${stage + 1} of 3`}><Inline>
        {LABELS.map((label, index) => <StatusMark key={label} spec={index < stage ? DONE : index === stage ? CURRENT : TODO} strong={index === stage}>{`${label}${index === stage ? " (current)" : ""}`}</StatusMark>)}
      </Inline></View>
      <Heading>{LABELS[stage] ?? ""}</Heading>
      {stage === 0 ? goal : stage === 1 ? context : review}
      <Inline>
        {hasGoal && manualOnly && <Button title="Continue with my coding tool" onPress={() => setOpen(false)} />}
        <Button title="Back" icon={ArrowLeft} variant="subtle" disabled={stage === 0} onPress={() => setStage((s) => s - 1)} />
        {stage < 2 && <Button title={stage === 0 ? "Continue to context" : "Review and plan"} icon={ArrowRight} variant="primary"
          disabled={stage === 0 ? !hasGoal : !canReview} onPress={() => setStage((s) => s + 1)} />}
      </Inline>
    </Stack>}
  </Panel>;
}
