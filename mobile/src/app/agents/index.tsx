import { Stack } from "expo-router";
import { AgentDesk } from "../../features/agents/AgentDesk";

export default function AgentsIndex() {
  return <><Stack.Screen options={{ title: "Agent desk" }} /><AgentDesk /></>;
}
