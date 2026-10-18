import type { TriageAction, TriageBatch, TriageFilter, TriagePreview, TriageResult, TriageUndoResult } from "../triage/types.ts";

/** Browser client for Clean up (POST /api/triage/*). Shared by the Clean up page and the voice panel's Undo button. */
export class TriageRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

let csrf: Promise<string> | undefined;
const token = (): Promise<string> => {
  csrf ??= fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
    .then(async r => { if (!r.ok) throw new Error("Security bootstrap failed. Retry when ready."); return (await r.json() as { token: string }).token; })
    .catch((e: unknown) => { csrf = undefined; throw e; });
  return csrf;
};

/** Mutations are never retried automatically. */
async function call<T>(method: "GET" | "POST", url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method === "POST") { headers["x-dave-csrf"] = await token(); headers["content-type"] = "application/json"; }
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(url, { method, mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TriageRequestError(timeout.aborted ? "The request timed out. Nothing was changed; retry when ready." : "Could not reach DAVE. Retry when ready.", 0);
  }
  let result = null as { message?: string; error?: string } | null;
  try { result = await response.json() as typeof result; } catch { result = null; }
  if (!response.ok) {
    if (response.status === 403) csrf = undefined;
    const why = response.status === 404 ? result?.error ?? "Clean up is not available on this server yet." : result?.message ?? result?.error ?? "Request failed";
    throw new TriageRequestError(`${why} (${response.status})`, response.status);
  }
  return result as T;
}

export const triageApi = {
  preview: (filter: TriageFilter = {}, signal?: AbortSignal) => call<TriagePreview>("POST", "/api/triage/preview", { filter }, signal),
  apply: (keys: string[], action: TriageAction) => call<TriageResult>("POST", "/api/triage/apply", { keys, action }),
  undo: (batchId: string) => call<TriageUndoResult>("POST", "/api/triage/undo", { batchId }),
  batches: (signal?: AbortSignal) => call<{ batches: TriageBatch[] }>("GET", "/api/triage/batches", undefined, signal),
};
