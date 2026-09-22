import { Component, lazy, Suspense, type ReactNode } from "react";
import { Alert, Button, Text } from "@mantine/core";
import type { PortfolioProject } from "../../shared/types.ts";

const DeliveryView = lazy(() => import("./DeliveryView.tsx").then(module => ({ default: module.DeliveryView })));
class DeliveryLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Alert title="Delivery workspace unavailable" role="alert">The workspace could not load. Your saved work is unchanged. <Button variant="default" onClick={() => location.reload()}>Reload workspace</Button></Alert>;
    return this.props.children;
  }
}
/** No delivery form or coordination code is fetched until a work item is opened. */
export function LazyDeliveryView(props: { project: PortfolioProject; today?: boolean }) {
  return <DeliveryLoadBoundary><Suspense fallback={<Text role="status">Loading delivery workspace…</Text>}><DeliveryView {...props} /></Suspense></DeliveryLoadBoundary>;
}
