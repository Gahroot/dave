import { Text } from "@mantine/core";
import type { AgentRun } from "../../agents/types.ts";

/** Presentation only. The inbox owns agent reads and polling. */
export function AgentAttention({ run }: { run: AgentRun }) {
  return <><Text fw={600}>{run.title}</Text><Text size="sm">{run.status === "waiting" ? "Permission requested" : run.reason || "Review agent evidence"}</Text></>;
}
