import { Stack } from "expo-router";
import { AgentSettingsScreen } from "../../features/agents/AgentSettingsScreen";

export default function AgentSettingsRoute() {
  return <><Stack.Screen options={{ title: "Execution settings" }} /><AgentSettingsScreen /></>;
}
