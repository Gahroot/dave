import { Stack, useLocalSearchParams } from "expo-router";
import { CleanupScreen } from "../features/cleanup/CleanupScreen";
import { bucketOf } from "../features/cleanup/model";

export default function CleanupRoute() {
  const { bucket } = useLocalSearchParams<{ bucket?: string | string[] }>();
  return <>
    <Stack.Screen options={{ title: "Clean up" }} />
    <CleanupScreen bucket={bucketOf(bucket)} />
  </>;
}
