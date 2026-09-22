import { Button, Stack, Text, Title } from "@mantine/core";
import type { Coverage, PortfolioIssue } from "../../shared/types.ts";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";

export function Issues({ issues, coverage }: { issues: PortfolioIssue[]; coverage?: Coverage }) {
  const sources = [...new Set(issues.map(issue => issue.adapter))];
  return <Stack gap="md">
    <PageHeader title="Diagnostics" />
    <Text size="sm">Source read failures, not failures in your code. Use Refresh above to retry discovery.</Text>
    {coverage && <Text size="sm">Coverage: {coverage.checked} checked · {coverage.cached} cached · {coverage.unavailable} unavailable · {coverage.waitingOutsideCap} waiting outside the scan</Text>}
    {!issues.length && <EmptyState title="No source errors in the loaded snapshot">This does not prove unchecked projects are healthy.</EmptyState>}
    {sources.map(source => <section className="workspace-detail" key={source}><Stack gap="sm"><Title order={3}>{source}</Title>{issues.filter(issue => issue.adapter === source).map((issue, index) => <div key={index}><Text>{issue.message}</Text><details><summary>Source details</summary><Text size="sm">Path: {issue.path ?? "Not available"}</Text><Text size="sm">Observed: {issue.observedAt}</Text></details></div>)}</Stack></section>)}
    <Button component="a" href="#projects?waiting=1" variant="default">Review waiting projects</Button>
  </Stack>;
}
