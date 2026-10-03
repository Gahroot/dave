import { Button, Stack, Text, Title } from "@mantine/core";
import { ArrowRight, CircleAlert, CircleCheck, Clock } from "lucide-react";
import type { Coverage, PortfolioIssue } from "../../shared/types.ts";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
import { CountPill, StatusIcon, StatusMark } from "../components/Status.tsx";
import { FRESHNESS, type StatusSpec } from "../status.ts";
import { relative } from "../format.ts";

const SOURCE_ERROR: StatusSpec = { tone: "red", icon: CircleAlert, label: "Read failed" };
const WAITING: StatusSpec = { tone: "amber", icon: Clock, label: "Waiting outside the scan" };

export function Issues({ issues, coverage }: { issues: PortfolioIssue[]; coverage?: Coverage }) {
  const sources = [...new Set(issues.map(issue => issue.adapter))];
  return <Stack gap="md">
    <PageHeader title="Diagnostics" />
    {coverage && <div className="count-strip" role="group" aria-label="Coverage">
      <StatusMark spec={FRESHNESS.checked}><strong>{coverage.checked}</strong> checked</StatusMark>
      <StatusMark spec={FRESHNESS.cached}><strong>{coverage.cached}</strong> cached</StatusMark>
      <StatusMark spec={coverage.unavailable ? FRESHNESS.unavailable : { ...FRESHNESS.unavailable, tone: "gray" }}><strong>{coverage.unavailable}</strong> unavailable</StatusMark>
      {!!coverage.waitingOutsideCap && <StatusMark spec={WAITING}><strong>{coverage.waitingOutsideCap}</strong> waiting outside the scan</StatusMark>}
    </div>}
    <Text size="sm" c="dimmed">Source read failures, not failures in your code. Use Refresh above to retry discovery.</Text>
    {!issues.length && <EmptyState title="No source errors in the loaded snapshot">This does not prove unchecked projects are healthy.</EmptyState>}
    {sources.map(source => { const list = issues.filter(issue => issue.adapter === source); return <section className="workspace-detail issue-source" key={source} aria-labelledby={`issue-${source}`}><Stack gap="xs">
      <Title order={3} id={`issue-${source}`} className="meeting-group-title"><StatusIcon spec={SOURCE_ERROR} />{source} <CountPill value={list.length} tone="red" decorative={false} /></Title>
      <ul className="result-list">{list.map((issue, index) => <li key={index} className="result-row"><StatusIcon spec={SOURCE_ERROR} /><span className="result-row-title">{issue.message}</span><span className="result-row-detail" title={issue.observedAt}>Observed {relative(issue.observedAt)}</span><details className="quiet-details"><summary>Source details</summary><Text size="sm">Path: {issue.path ?? "Not available"}</Text><Text size="sm">Observed: {issue.observedAt}</Text></details></li>)}</ul>
    </Stack></section>; })}
    {!issues.length && coverage && !coverage.unavailable && <StatusMark spec={{ tone: "green", icon: CircleCheck, label: "" }}>Every loaded source read cleanly.</StatusMark>}
    <Button component="a" href="#projects?waiting=1" variant="default" rightSection={<ArrowRight size={16} aria-hidden="true" />}>Review waiting projects</Button>
  </Stack>;
}
