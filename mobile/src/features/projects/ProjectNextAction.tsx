/** Port of src/ui/components/ProjectNextAction.tsx: the owner's chosen next action on a pinned project. */
import { router } from "expo-router";
import { ArrowRight, CircleAlert } from "lucide-react-native";
import type { Portfolio } from "../../../../src/shared/types.ts";
import { clean, projectWorkBrief, relative } from "../../../../src/ui/format.ts";
import { FRESHNESS } from "../../../../src/ui/status.ts";
import { Body, Button, Caption, CopyButton, Inline, Muted, Panel } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { scanOf, selectProjectNextAction } from "./model";

export function ProjectNextAction({ portfolio }: { portfolio: Portfolio }) {
  const p = selectProjectNextAction(portfolio);
  if (!p) return null;
  return <Panel title={`Chosen next action · ${clean(p.name, 200)}`} spec={{ tone: "blue", icon: ArrowRight, label: "" }}>
    <Body strong selectable>{clean(p.summary.suggestedNextAction ?? "", 400)}</Body>
    {p.summary.recentFocus ? <Muted selectable>{clean(p.summary.recentFocus, 400)}</Muted> : null}
    {p.summary.unfinished ? <StatusMark spec={{ tone: "amber", icon: CircleAlert, label: "" }}>Blocked / unfinished: {clean(p.summary.unfinished, 400)}</StatusMark> : null}
    <Inline><StatusMark spec={FRESHNESS[scanOf(p)]} /><Caption>Action saved {relative(p.summary.nextActionEditedAt)}</Caption></Inline>
    <Inline>
      <Button title="View/update project" variant="primary" icon={ArrowRight} onPress={() => router.push(`/project/${p.id}`)} />
      <CopyButton text={projectWorkBrief(p)} label="Copy work brief" />
    </Inline>
  </Panel>;
}
