import type { ReviewReport } from "../intel/ledger-types.ts";
import { IntelRequestError } from "./intel-api.ts";

/**
 * Typed fetchers for the recommendation review. intel-api.ts keeps its fetch/CSRF helper private, so this mirrors it
 * (same-origin, CSRF header on POST, 30 s timeout, token refetched after a 403).
 */
type Holder = { token: Promise<string> | undefined };
const holder: Holder = { token: undefined };

function token(): Promise<string> {
  holder.token ??= fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
    .then(async (r) => { if (!r.ok) throw new Error("Security bootstrap failed. Retry when ready."); return (await r.json() as { token: string }).token; })
    .catch((e: unknown) => { holder.token = undefined; throw e; });
  return holder.token;
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method === "POST") { headers["x-dave-csrf"] = await token(); headers["content-type"] = "application/json"; }
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(url, { method, mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new IntelRequestError(timeout.aborted ? "The request timed out. Retry when ready." : "Could not reach DAVE. Retry when ready.", 0);
  }
  let result = null as { error?: string; message?: string } | null;
  try { result = await response.json() as typeof result; } catch { result = null; }
  if (!response.ok) {
    if (response.status === 403) holder.token = undefined;
    throw new IntelRequestError(result?.error ?? result?.message ?? `Request failed (${response.status})`, response.status);
  }
  return result as T;
}

export type ApplySuggestionResult = { applied: true; report: ReviewReport };

export const reviewApi = {
  review: (days: number, signal?: AbortSignal): Promise<ReviewReport> => call("GET", `/api/intel/recommendations/review?days=${encodeURIComponent(String(days))}`, undefined, signal),
  applySuggestion: (id: string): Promise<ApplySuggestionResult> => call("POST", "/api/intel/recommendations/suggestions/apply", { id }),
};
