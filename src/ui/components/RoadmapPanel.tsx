import { Stack, Text } from "@mantine/core";
import type { Roadmap } from "../../model/roadmap.ts";
import { routeLink } from "../navigation.ts";

/** Where each active project stands against what "delivered" means, and what the plan is missing. */
export function RoadmapPanel({ roadmaps }: { roadmaps: readonly Roadmap[] }) {
  if (!roadmaps.length) return null;
  return <section aria-label="Roadmaps" data-testid="roadmaps"><Stack gap="xs">
    <Text size="xs" tt="uppercase" fw={700} c="dimmed">Roadmaps · active projects</Text>
    {roadmaps.map(r => <div key={r.projectId} className="roadmap-row">
      <Text fw={600} component="a" href={routeLink("queue", { delivery: r.projectId })}>{r.projectName}</Text>
      <Text size="sm">{r.problem ? r.problem : `${r.progress.milestonesAccepted} of ${r.progress.milestonesTotal} milestones accepted · ${r.progress.criteriaMet} of ${r.progress.criteriaTotal} finish criteria met`}</Text>
      {r.finish && <Text size="xs" c="dimmed">Delivered means: {r.finish}</Text>}
      {r.gaps.length > 0 && <Text size="sm" c="orange.8">{r.gaps.length} {r.gaps.length === 1 ? "requirement is" : "requirements are"} not in the plan: {r.gaps.slice(0, 3).map(g => g.text).join("; ")}{r.gaps.length > 3 ? "…" : ""}</Text>}
    </div>)}
  </Stack></section>;
}
