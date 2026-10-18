import type { Briefing, BriefingCaller, NextActResult, NextState, PreparedOpName } from "../intel/next-types.ts";

export class NextRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Fetches the CSRF token per call (same bootstrap as intel-api); mutations are never retried automatically. */
async function csrfToken(signal?: AbortSignal): Promise<string> {
  const r = await fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (!r.ok) throw new NextRequestError("Security bootstrap failed. Retry when ready.", r.status);
  return (await r.json() as { token: string }).token;
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") { headers["x-dave-csrf"] = await csrfToken(signal); headers["content-type"] = "application/json"; }
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(url, { method, mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new NextRequestError(timeout.aborted ? "The request timed out. Retry when ready." : "Could not reach DAVE. Retry when ready.", 0);
  }
  let result = null as { error?: string; message?: string } | null;
  try { result = await response.json() as typeof result; } catch { result = null; }
  if (!response.ok) throw new NextRequestError(`${result?.error ?? result?.message ?? "Request failed"} (${response.status})`, response.status);
  return result as T;
}

export type NextActInput = { op: PreparedOpName; note?: string; date?: string };

export const nextApi = {
  next: (signal?: AbortSignal) => call<NextState>("GET", "/api/intel/next", undefined, signal),
  act: (actionId: string, input: NextActInput, signal?: AbortSignal) => call<NextActResult>("POST", `/api/intel/next/${encodeURIComponent(actionId)}/act`, input, signal),
  briefing: (query: { since?: string; caller?: BriefingCaller } = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (query.since) qs.set("since", query.since);
    if (query.caller) qs.set("caller", query.caller);
    const s = qs.toString();
    return call<Briefing>("GET", `/api/intel/briefing${s ? `?${s}` : ""}`, undefined, signal);
  },
};
