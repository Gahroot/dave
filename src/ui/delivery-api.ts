import type { DeliveryState } from "../model/delivery-schema.ts";

export class DeliveryRequestError extends Error {
  status: number;
  state?: DeliveryState;
  constructor(message: string, status: number, state?: DeliveryState) { super(message); this.status = status; this.state = state; }
}
let csrf: Promise<string> | undefined;
/** New guarded namespaces only. Never replay a mutation automatically. */
export async function deliveryApi<T>(url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    csrf ??= fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000) })
      .then(async r => { if (!r.ok) throw new Error("Security bootstrap failed. Retry when ready."); return (await r.json() as { token: string }).token; })
      .catch(e => { csrf = undefined; throw e; });
    headers["x-dave-csrf"] = await csrf;
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 403) csrf = undefined;
    throw new DeliveryRequestError(`${result.message ?? result.error ?? "Request failed"}. ${response.status === 409 ? "Latest saved state loaded; your draft is retained. Review it before retrying." : "Your draft is retained. Check Connections or retry when ready."}`, response.status, result.state);
  }
  return result as T;
}
