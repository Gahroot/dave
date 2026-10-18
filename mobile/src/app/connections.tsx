import { Stack } from "expo-router";
import { ConnectionsScreen } from "../features/connections/ConnectionsScreen";

export default function ConnectionsRoute() {
  return <><Stack.Screen options={{ title: "Connections" }} /><ConnectionsScreen /></>;
}
