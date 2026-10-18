import { TRIAGE_BUCKETS, type TriageBucket } from "../triage/types.ts";

export type Destination = "focus" | "queue" | "projects" | "agents" | "meetings" | "cleanup" | "connections" | "issues" | "voice";
export type MeetingSection = "promises" | "asks" | "list" | "instructions";
export type ProjectTab = "overview" | "delivery" | "context";
export type InboxFilter = "all" | "decision" | "ready" | "waiting";
export type RunFilter = "all" | "attention" | "active" | "queued" | "finished";
const destinations = new Set<string>(["focus", "queue", "projects", "agents", "meetings", "cleanup", "connections", "issues", "voice"]);
/** Fathom recording ids are digits only. */
const recordingId = (value: string | null): string | null => value && /^\d{1,20}$/.test(value) ? value : null;
const identifier = (value: string | null): string | null => value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const bucketOf = (value: string | null): TriageBucket | null => TRIAGE_BUCKETS.find((b) => b === value) ?? null;
/** Meeting item ids are derived hashes; anything else is dropped. */
const meetingItemId = (value: string | null): string | null => value && /^mi-[0-9a-f]{24}$/.test(value) ? value : null;

function inboxPage(value: string | null): number {
  if (!value || !/^[1-9]\d{0,3}$/.test(value)) return 1;
  return Math.min(Number(value), 1000);
}

/** URL state contains navigation only. Unknown parameters never survive normalization. */
export function parseRoute(hash: string) {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const [base, rawRun, ...rest] = path.split("/");
  const destination: Destination = destinations.has(base!) ? base as Destination : "focus";
  const query = new URLSearchParams(search);
  const runId = destination === "agents" && rawRun && /^[a-f0-9-]{36}$/.test(rawRun) && !rest.length ? rawRun : null;
  return {
    destination, runId,
    invalidRun: destination === "agents" && rawRun !== undefined && !runId,
    id: identifier(query.get("id")), item: identifier(query.get("item")), delivery: identifier(query.get("delivery")),
    invalidSelection: ["id", "item", "delivery", ...(destination === "focus" ? ["project"] : [])].some(key => query.has(key) && !identifier(query.get(key))) ||
      (destination === "meetings" && query.has("rec") && !recordingId(query.get("rec"))),
    rec: destination === "meetings" ? recordingId(query.get("rec")) : null,
    section: oneOf(query.get("section"), ["promises", "asks", "list", "instructions"] as const, "promises"),
    q: (query.get("q") ?? "").slice(0, 1000), waiting: query.get("waiting") === "1", hidden: query.get("hidden") === "1",
    tab: oneOf(query.get("tab"), ["overview", "delivery", "context"] as const, "delivery"),
    page: inboxPage(query.get("page")),
    filter: oneOf(query.get("filter"), ["all", "decision", "ready", "waiting"] as const, "all"),
    runFilter: oneOf(query.get("filter"), ["all", "attention", "active", "queued", "finished"] as const, "all"),
    view: oneOf(query.get("view"), ["runs", "new", "settings"] as const, "runs"),
    project: identifier(query.get("project")), handoff: identifier(query.get("handoff")),
    meetingItem: meetingItemId(query.get("meetingItem")),
    /** Clean up: which bucket to open (validated; unknown values are dropped). */
    bucket: destination === "cleanup" ? bucketOf(query.get("bucket")) : null,
    returnTo: safeReturn(query.get("return")),
  };
}

export function routeLink(destination: Destination, values: Record<string, string | boolean | null | undefined> = {}, runId?: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== false && value !== "") params.set(key, value === true ? "1" : value);
  const path = destination === "agents" && runId && /^[a-f0-9-]{36}$/.test(runId) ? `agents/${runId}` : destination;
  return `#${path}${params.size ? `?${params}` : ""}`;
}

/** No redirects to arbitrary URLs, nested returns, or private text. */
export function safeReturn(value: string | null): string | null {
  if (!value || value.length > 2000 || !/^#(focus|queue|projects|agents|meetings|cleanup)(\?|\/|$)/.test(value)) return null;
  const [path = "", query = ""] = value.slice(1).split("?");
  const params = new URLSearchParams(query);
  params.delete("return");
  const clean = parseRouteWithoutReturn(path, params);
  return clean;
}
function parseRouteWithoutReturn(path: string, params: URLSearchParams): string | null {
  const route = parseRoute(`#${path}?${params}`);
  if (route.invalidRun || route.invalidSelection) return null;
  if (route.destination === "focus") return routeLink("focus", { project: route.project });
  if (route.destination === "queue") return routeLink("queue", { item: route.item, delivery: route.delivery, filter: route.filter === "all" ? null : route.filter, page: route.page > 1 ? String(route.page) : null });
  if (route.destination === "projects") return routeLink("projects", { id: route.id, q: route.q, waiting: route.waiting, hidden: route.hidden, tab: route.tab });
  if (route.destination === "agents") return routeLink("agents", { view: route.view, project: route.project, handoff: route.handoff, meetingItem: route.meetingItem, filter: route.runFilter }, route.runId);
  if (route.destination === "meetings") return routeLink("meetings", { section: route.section === "promises" ? null : route.section, rec: route.rec });
  if (route.destination === "cleanup") return routeLink("cleanup", { bucket: route.bucket });
  return null;
}
