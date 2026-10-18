import { Stack, useLocalSearchParams } from "expo-router";
import { AgentAssignmentScreen } from "../../features/agents/AgentAssignmentScreen";
import { identifier, meetingItemId } from "../../features/agents/model";

export default function NewAssignmentRoute() {
  const params = useLocalSearchParams<{ project?: string; handoff?: string; meetingItem?: string }>();
  const project = identifier(params.project), handoff = identifier(params.handoff), meetingItem = meetingItemId(params.meetingItem);
  return <><Stack.Screen options={{ title: "New assignment" }} />
    <AgentAssignmentScreen key={`${project}:${handoff}:${meetingItem}`} projectId={project} handoffId={handoff} meetingItemId={meetingItem} /></>;
}
