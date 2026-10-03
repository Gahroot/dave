import type { ReactNode } from "react";
import { Button, Group, Stack } from "@mantine/core";
import { Bot, Copy } from "lucide-react";
import { StatusIcon } from "../../components/Status.tsx";
import { MILESTONE_STATUS, type MilestoneStatus } from "../../status.ts";

export function WorkMethod({ method, onChange, connected, manual }: { method: "connected" | "manual"; onChange: (method: "connected" | "manual") => void; connected: ReactNode; manual: ReactNode }) {
  return <Stack gap="sm"><Group aria-label="Delivery method" gap="xs"><Button variant={method === "connected" ? "filled" : "default"} leftSection={<Bot size={16} aria-hidden="true" />} aria-pressed={method === "connected"} onClick={() => onChange("connected")}>Run in DAVE</Button><Button variant={method === "manual" ? "filled" : "default"} leftSection={<Copy size={16} aria-hidden="true" />} aria-pressed={method === "manual"} onClick={() => onChange("manual")}>Use another tool</Button></Group>{method === "connected" ? connected : manual}</Stack>;
}

/** The milestone order as a visible stepper: one mark and one word per piece, the current one emphasised. */
export function MilestoneSequence({ items, current }: { items: { id: string; title: string; status: MilestoneStatus }[]; current?: string | undefined }) {
  if (!items.length) return null;
  return <ol className="milestone-strip" aria-label={`Milestones, ${items.filter(item => item.status === "accepted").length} of ${items.length} accepted`}>
    {items.map((item, index) => { const spec = MILESTONE_STATUS[item.status]; return <li key={item.id} data-tone={spec.tone} aria-current={item.id === current ? "step" : undefined}>
      <StatusIcon spec={spec} />
      <span className="milestone-strip-text"><span className="milestone-strip-title">{index + 1}. {item.title}</span><span className="milestone-strip-state">{spec.label}</span></span>
    </li>; })}
  </ol>;
}
export function StagePanel({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="delivery-stage"><Stack gap="sm">{children}</Stack></section>;
}
