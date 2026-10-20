import { Stack } from "expo-router";
import { IssuesScreen } from "../features/issues/IssuesScreen";
export default function IssuesRoute() { return <><Stack.Screen options={{ title: "Diagnostics" }} /><IssuesScreen /></>; }
