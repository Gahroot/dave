import { useLocalSearchParams } from "expo-router";
import { routeId } from "../../lib/portfolio";
import { ProjectWorkspaceScreen } from "../../features/projects/ProjectWorkspaceScreen";
export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = routeId(id);
  // key: a different project starts with fresh drafts and tab state.
  return <ProjectWorkspaceScreen key={valid ?? "invalid"} id={valid} />;
}
