import type { FocusState, ItemKind, Owner, ProjectIntel, DeliveryStage, EvidenceState, ItemStatus, Lane, MarkableStep, ReadinessLevel } from "../intel/types.ts";

export class IntelRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

let csrf: Promise<string> | undefined;
const token = (): Promise<string> => {
  csrf ??= fetch("/api/security/csrf", { mode: "same-origin", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
    .then(async r => { if (!r.ok) throw new Error("Security bootstrap failed. Retry when ready."); return (await r.json() as { token: string }).token; })
    .catch(e => { csrf = undefined; throw e; });
  return csrf;
};

/** Reads time out after 30s like App.tsx api(); reconcile may take longer. Mutations are never retried automatically. */
async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") { headers["x-dave-csrf"] = await token(); headers["content-type"] = "application/json"; }
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method, mode: "same-origin", credentials: "same-origin", cache: "no-store", headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new IntelRequestError(timeout.aborted ? "The request timed out. Nothing was changed on your screen; retry when ready." : "Could not reach DAVE. Retry when ready.", 0);
  }
  let result = null as { message?: string; error?: string } | null;
  try { result = await response.json() as typeof result; } catch { result = null; }
  if (!response.ok) {
    if (response.status === 403) csrf = undefined;
    const why = response.status === 404 ? "Delivery intelligence is not available on this server yet." : result?.message ?? result?.error ?? "Request failed";
    throw new IntelRequestError(`${why} (${response.status}). Your edits are kept on screen.`, response.status);
  }
  return result as T;
}

const enc = encodeURIComponent;
export type OutcomeInput = { desiredOutcome: string; acceptanceCriteria: string[]; stage?: DeliveryStage; lock?: boolean; targetDate?: string | null; startDate?: string | null };
export type NewItemInput = { kind: ItemKind; title: string; detail?: string; dueDate?: string; owner?: Owner; acceptance?: string[]; dependsOn?: string[] };
export type ItemPatch = { title?: string; detail?: string; status?: ItemStatus; evidenceState?: EvidenceState; owner?: Owner; dueDate?: string | null; acceptance?: string[]; locked?: boolean; readinessReached?: ReadinessLevel | null; confirm?: boolean; lane?: Lane | null; goal?: string | null };
export type ScheduleInput = { targetDate: string | null; startDate?: string | null };
export type FinishLineItemInput = { title: string; detail?: string | null; acceptance?: string[]; goal?: string | null };
export type FinishLineResult = { added: number; skipped: number; intel: ProjectIntel };

export const intelApi = {
  focus: (signal?: AbortSignal) => call<FocusState>("GET", "/api/intel/focus", undefined, signal),
  project: (id: string, signal?: AbortSignal) => call<ProjectIntel>("GET", `/api/intel/projects/${enc(id)}`, undefined, signal),
  reconcile: (projectId?: string, signal?: AbortSignal) => call<FocusState>("POST", "/api/intel/reconcile", projectId ? { projectId } : {}, signal, 120_000),
  putOutcome: (id: string, input: OutcomeInput) => call<ProjectIntel>("PUT", `/api/intel/projects/${enc(id)}/outcome`, input),
  addItem: (id: string, input: NewItemInput) => call<ProjectIntel>("POST", `/api/intel/projects/${enc(id)}/items`, input),
  patchItem: (itemId: string, patch: ItemPatch) => call<ProjectIntel>("PATCH", `/api/intel/items/${enc(itemId)}`, patch),
  accept: (proposalId: string, note?: string, lane?: Lane) => call<FocusState>("POST", `/api/intel/proposals/${enc(proposalId)}/accept`, { ...(note ? { note } : {}), ...(lane ? { lane } : {}) }),
  reject: (proposalId: string, note?: string) => call<FocusState>("POST", `/api/intel/proposals/${enc(proposalId)}/reject`, note ? { note } : {}),
  setSchedule: (id: string, input: ScheduleInput) => call<ProjectIntel>("PUT", `/api/intel/projects/${enc(id)}/schedule`, input),
  setStep: (id: string, step: MarkableStep, reached: boolean) => call<ProjectIntel>("POST", `/api/intel/projects/${enc(id)}/steps`, { step, reached }),
  markDemo: (id: string) => call<ProjectIntel>("POST", `/api/intel/projects/${enc(id)}/demo`, {}),
  markSent: (id: string, itemIds: string[], sent: boolean) => call<ProjectIntel>("POST", `/api/intel/projects/${enc(id)}/tasks/sent`, { itemIds, sent }),
  addFinishLine: (id: string, items: FinishLineItemInput[], acceptance?: string[]) =>
    call<FinishLineResult>("POST", `/api/intel/projects/${enc(id)}/finish-line`, acceptance?.length ? { items, acceptance } : { items }),
  verifyItem: (itemId: string) => call<ProjectIntel>("POST", `/api/intel/items/${enc(itemId)}/verify`, {}),
  reopenItem: (itemId: string, note?: string) => call<ProjectIntel>("POST", `/api/intel/items/${enc(itemId)}/reopen`, note ? { note } : {}),
};
