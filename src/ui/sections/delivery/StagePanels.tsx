import type { ReactNode } from "react";
import { Button, Group, Stack, Text } from "@mantine/core";

export function WorkMethod({ method, onChange, connected, manual }: { method: "connected" | "manual"; onChange: (method: "connected" | "manual") => void; connected: ReactNode; manual: ReactNode }) {
  return <Stack gap="sm"><Group aria-label="Delivery method"><Button variant={method === "connected" ? "filled" : "default"} aria-pressed={method === "connected"} onClick={() => onChange("connected")}>Run in DAVE</Button><Button variant={method === "manual" ? "filled" : "default"} aria-pressed={method === "manual"} onClick={() => onChange("manual")}>Use another tool</Button></Group>{method === "connected" ? connected : manual}</Stack>;
}
export function MilestoneSequence({ items }: { items: { id: string; title: string; status: string }[] }) {
  if (!items.length) return null;
  return <details><summary>Milestone sequence ({items.length})</summary><ol>{items.map(item => <li key={item.id}><Text size="sm">{item.title}: {item.status}</Text></li>)}</ol></details>;
}
export function StagePanel({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="delivery-stage"><Stack gap="sm">{children}</Stack></section>;
}
