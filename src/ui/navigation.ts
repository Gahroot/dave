export type Destination = "queue" | "projects" | "agents" | "connections" | "issues";
export type ProjectTab = "overview" | "delivery" | "context";
export type InboxFilter = "all" | "decision" | "ready" | "waiting";
export type RunFilter = "all" | "attention" | "active" | "queued" | "finished";
const destinations = new Set<string>(["queue", "projects", "agents", "connections", "issues"]);
const identifier = (value: string | null): string | null => value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;

/** URL state contains navigation only. Unknown parameters never survive normalization. */
export function parseRoute(hash: string) {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const [base, rawRun, ...rest] = path.split("/");
  const destination: Destination = destinations.has(base!) ? base as Destination : "queue";
  const query = new URLSearchParams(search);
  const runId = destination === "agents" && rawRun && /^[a-f0-9-]{36}$/.test(rawRun) && !rest.length ? rawRun : null;
  return {
    destination, runId,
    invalidRun: destination === "agents" && rawRun !== undefined && !runId,
    id: identifier(query.get("id")), item: identifier(query.get("item")), delivery: identifier(query.get("delivery")),
    invalidSelection: ["id", "item", "delivery"].some(key => query.has(key) && !identifier(query.get(key))),
    q: (query.get("q") ?? "").slice(0, 1000), waiting: query.get("waiting") === "1", hidden: query.get("hidden") === "1",
    tab: oneOf(query.get("tab"), ["overview", "delivery", "context"] as const, "overview"),
    filter: oneOf(query.get("filter"), ["all", "decision", "ready", "waiting"] as const, "all"),
    runFilter: oneOf(query.get("filter"), ["all", "attention", "active", "queued", "finished"] as const, "all"),
    view: oneOf(query.get("view"), ["runs", "new", "settings"] as const, "runs"),
    project: identifier(query.get("project")), handoff: identifier(query.get("handoff")),
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
  if (!value || value.length > 2000 || !/^#(queue|projects|agents)(\?|\/|$)/.test(value)) return null;
  const [path = "", query = ""] = value.slice(1).split("?");
  const params = new URLSearchParams(query);
  params.delete("return");
  const clean = parseRouteWithoutReturn(path, params);
  return clean;
}
function parseRouteWithoutReturn(path: string, params: URLSearchParams): string | null {
  const route = parseRoute(`#${path}?${params}`);
  if (route.invalidRun || route.invalidSelection) return null;
  if (route.destination === "queue") return routeLink("queue", { item: route.item, delivery: route.delivery, filter: route.filter === "all" ? null : route.filter });
  if (route.destination === "projects") return routeLink("projects", { id: route.id, q: route.q, waiting: route.waiting, hidden: route.hidden, tab: route.tab });
  if (route.destination === "agents") return routeLink("agents", { view: route.view, project: route.project, handoff: route.handoff, filter: route.runFilter }, route.runId);
  return null;
}
