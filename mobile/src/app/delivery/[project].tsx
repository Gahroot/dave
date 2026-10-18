import { useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { findProject, routeId, usePortfolio } from "../../lib/portfolio";
import { EmptyState, ErrorState, LoadingState, Screen } from "../../ui/primitives";
import { ProjectDeliveryPanel } from "../../features/delivery/ProjectDeliveryPanel";

export default function DeliveryScreen() {
  const params = useLocalSearchParams<{ project?: string; today?: string }>();
  const id = routeId(params.project);
  const today = params.today === "1";
  const portfolio = usePortfolio();
  const project = findProject(portfolio.data, id);
  // Pull-to-refresh re-reads the portfolio and the saved delivery state; drafts are kept.
  const [generation, setGeneration] = useState(0);
  const refresh = () => { setGeneration((g) => g + 1); void portfolio.reload(); };
  return <Screen refreshing={portfolio.refreshing} onRefresh={refresh}>
    <Stack.Screen options={{ title: project ? `${today ? "Today · " : ""}${project.name}` : "Delivery" }} />
    {!id ? <EmptyState title="Unknown project" message="This link does not name a valid project." />
      : project ? <ProjectDeliveryPanel project={project} today={today} refreshToken={generation} />
      : portfolio.loading ? <LoadingState />
      : portfolio.error ? <ErrorState message={portfolio.error} onRetry={() => void portfolio.reload()} />
      : <EmptyState title="Project not found" message="It may have been removed or hidden. Pull to refresh." />}
  </Screen>;
}
