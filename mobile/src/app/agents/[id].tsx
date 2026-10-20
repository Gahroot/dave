import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { RunWorkspace } from "../../features/agents/RunWorkspace";
import { runId } from "../../features/agents/model";
import { Button, EmptyState, Screen } from "../../ui/primitives";

export default function RunRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const id = runId(params.id);
  if (!id) return <><Stack.Screen options={{ title: "Run" }} /><Screen>
    <EmptyState title="This run link is invalid" message="Inspect the response and evidence before accepting work."
      action={<Button title="All runs" onPress={() => router.replace("/agents")} />} />
  </Screen></>;
  return <><Stack.Screen options={{ title: "Run" }} /><RunWorkspace key={id} id={id} /></>;
}
