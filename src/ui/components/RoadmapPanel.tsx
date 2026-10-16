import { Text } from "@mantine/core";
import { Map as MapIcon } from "lucide-react";
import type { Roadmap } from "../../model/roadmap.ts";
import { routeLink } from "../navigation.ts";
import type { StatusSpec } from "../status.ts";
import { PanelHead } from "./WorkspacePrimitives.tsx";

const ROADMAP: StatusSpec = { tone: "blue", icon: MapIcon, label: "Roadmaps" };

/** Where each active project stands against what "delivered" means, and what the plan is missing. */
export function RoadmapPanel({ roadmaps }: { roadmaps: readonly Roadmap[] }) {
  if (!roadmaps.length) return null;
  return <section className="app-panel" aria-labelledby="roadmaps-h" data-testid="roadmaps">
    <PanelHead id="roadmaps-h" title="Roadmaps" spec={ROADMAP} count={roadmaps.length} note="Active projects, measured against what delivered means." />
    <ul className="plain-list">{roadmaps.map(r => <li key={r.projectId} className="roadmap-row">
      <Text fw={600} component="a" href={routeLink("queue", { delivery: r.projectId })}>{r.projectName}</Text>
      <Text size="sm">{r.problem ? r.problem : `${r.progress.milestonesAccepted} of ${r.progress.milestonesTotal} milestones accepted · ${r.progress.criteriaMet} of ${r.progress.criteriaTotal} finish criteria met`}</Text>
      {r.finish && <Text size="xs" c="dimmed">Delivered means: {r.finish}</Text>}
      {r.gaps.length > 0 && <Text size="sm" className="roadmap-gap">{r.gaps.length} {r.gaps.length === 1 ? "requirement is" : "requirements are"} not in the plan: {r.gaps.slice(0, 3).map(g => g.text).join("; ")}{r.gaps.length > 3 ? "…" : ""} · <Text span size="sm" component="a" href={routeLink("queue", { delivery: r.projectId })}>Review the plan and replan</Text></Text>}
    </li>)}</ul>
  </section>;
}
