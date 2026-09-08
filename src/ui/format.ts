import type { InboxItem, PortfolioProject } from "../shared/types.ts";

const DAY = 86_400_000;

/** Bounded context, not an executable script or a full transcript. */
export function handoff(project: PortfolioProject, item: InboxItem): string {
  const clean = (value: string, limit = 600) => value
    .replace(/```[\s\S]*?```/g, "[code omitted]")
    .replace(/`[^`]*`/g, "[code omitted]")
    .replace(/(?:bearer\s+|(?:api[_ -]?key|password|token|secret)\s*[:=]\s*)\S+/gi, "[credential omitted]")
    .replace(/\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]+|AKIA[A-Z0-9]{16})\b/g, "[credential omitted]")
    .replace(/https?:\/\/\S+/gi, "[URL omitted]")
    .replace(/(?:\$\s|\b(?:sudo|npm|npx|bash|sh|curl|git|rm|node|python)\s)[^\n]*/g, " [command omitted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
  return ["Project handoff (context only; no execution authorized)",
    `Directory: ${clean(project.canonicalPath, 1000)}`,
    `Observed request: ${clean(item.detail)}`,
    `Suggested next step: ${clean(item.nextStep)}`,
    `Source identity: ${clean(item.subjectKey ?? "legacy evidence", 300)}`,
    `First seen: ${item.createdAt}`,
    `Last observed: ${item.lastObservedAt ?? "unknown"}`,
    ...item.evidence.slice(0, 4).map((e) => `Source: ${e.kind}; ${clean(e.path ?? "task record", 300)}; ${clean(e.observedAt || "unknown", 50)}`),
  ].join("\n").slice(0, 3500);
}

/** Compact "3d ago" style rendering; null stays explicitly unknown. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return "Not provided";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Not provided";
  const diff = Date.now() - t;
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < DAY) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / DAY)}d ago`;
}
