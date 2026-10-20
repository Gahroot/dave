import { Stack, useLocalSearchParams } from "expo-router";
import { ProjectFocus } from "../../features/focus/ProjectFocus";
import { routeId } from "../../lib/portfolio";
import { EmptyState, Screen } from "../../ui/primitives";

/** Project focus: finish line, moves, tasks for EZcoder, extras, editor and evidence. */
export default function ProjectFocusRoute() {
  const params = useLocalSearchParams<{ project?: string | string[] }>();
  const id = routeId(params.project);
  if (!id) return <Screen>
    <Stack.Screen options={{ title: "Project focus" }} />
    <EmptyState title="Project not found" message="This link does not name a valid project. Go back to Focus and pick one." />
  </Screen>;
  return <ProjectFocus key={id} projectId={id} />;
}
