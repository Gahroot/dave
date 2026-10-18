import { Stack } from "expo-router";
import type { MeetingsState } from "../../../../src/meetings/types.ts";
import { InstructionsPanel } from "../../features/meetings/InstructionsPanel";
import { useResource } from "../../lib/useResource";
import { Screen } from "../../ui/primitives";

export default function InstructionsRoute() {
  const status = useResource<MeetingsState>("/api/meetings/status");
  return <Screen refreshing={status.refreshing} onRefresh={() => void status.reload()}>
    <Stack.Screen options={{ title: "Reading instructions" }} />
    <InstructionsPanel state={status.data} onChanged={() => void status.reload()} />
  </Screen>;
}
