/**
 * The web's intel-api.ts over the sealed transport: same methods, paths, bodies and
 * timeouts (30 s, reconcile 120 s). Errors keep their ApiError status (409 handling)
 * but carry the web's wording.
 */
import { useMemo } from "react";
import type { DirectionPatch, FocusState, Lane, MarkableStep, ProjectIntel } from "../../../../src/intel/types.ts";
import type { FinishLineItemInput, FinishLineResult, ItemPatch, NewItemInput, NoteResult, OutcomeInput, ScheduleInput } from "../../../../src/ui/intel-api.ts";
import { ApiError, type Api } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { intelErrorText } from "./model";

export type { FinishLineItemInput, ItemPatch, NewItemInput, OutcomeInput, ScheduleInput };

const enc = encodeURIComponent;
const READ_MS = 30_000;
const RECONCILE_MS = 120_000;

async function wrap<T>(work: Promise<T>): Promise<T> {
  try { return await work; } catch (e) {
    if (e instanceof ApiError) throw new ApiError(intelErrorText(e.status, e.message), e.status, e.body);
    throw e;
  }
}

export type IntelApi = ReturnType<typeof intelApiOver>;

export function intelApiOver(api: Api) {
  const opts = (signal?: AbortSignal, timeoutMs = READ_MS) => ({ signal, timeoutMs });
  return {
    focus: (signal?: AbortSignal) => wrap(api.get<FocusState>("/api/intel/focus", opts(signal))),
    project: (id: string, signal?: AbortSignal) => wrap(api.get<ProjectIntel>(`/api/intel/projects/${enc(id)}`, opts(signal))),
    reconcile: (projectId?: string, signal?: AbortSignal) => wrap(api.post<FocusState>("/api/intel/reconcile", projectId ? { projectId } : {}, opts(signal, RECONCILE_MS))),
    putOutcome: (id: string, input: OutcomeInput) => wrap(api.put<ProjectIntel>(`/api/intel/projects/${enc(id)}/outcome`, input, opts())),
    addItem: (id: string, input: NewItemInput) => wrap(api.post<ProjectIntel>(`/api/intel/projects/${enc(id)}/items`, input, opts())),
    patchItem: (itemId: string, patch: ItemPatch) => wrap(api.patch<ProjectIntel>(`/api/intel/items/${enc(itemId)}`, patch, opts())),
    accept: (proposalId: string, note?: string, lane?: Lane) =>
      wrap(api.post<FocusState>(`/api/intel/proposals/${enc(proposalId)}/accept`, { ...(note ? { note } : {}), ...(lane ? { lane } : {}) }, opts())),
    reject: (proposalId: string, note?: string) => wrap(api.post<FocusState>(`/api/intel/proposals/${enc(proposalId)}/reject`, note ? { note } : {}, opts())),
    setSchedule: (id: string, input: ScheduleInput) => wrap(api.put<ProjectIntel>(`/api/intel/projects/${enc(id)}/schedule`, input, opts())),
    setStep: (id: string, step: MarkableStep, reached: boolean) => wrap(api.post<ProjectIntel>(`/api/intel/projects/${enc(id)}/steps`, { step, reached }, opts())),
    markDemo: (id: string) => wrap(api.post<ProjectIntel>(`/api/intel/projects/${enc(id)}/demo`, {}, opts())),
    markSent: (id: string, itemIds: string[], sent: boolean) => wrap(api.post<ProjectIntel>(`/api/intel/projects/${enc(id)}/tasks/sent`, { itemIds, sent }, opts())),
    addFinishLine: (id: string, items: FinishLineItemInput[], acceptance?: string[]) =>
      wrap(api.post<FinishLineResult>(`/api/intel/projects/${enc(id)}/finish-line`, acceptance?.length ? { items, acceptance } : { items }, opts())),
    verifyItem: (itemId: string) => wrap(api.post<ProjectIntel>(`/api/intel/items/${enc(itemId)}/verify`, {}, opts())),
    reopenItem: (itemId: string, note?: string) => wrap(api.post<ProjectIntel>(`/api/intel/items/${enc(itemId)}/reopen`, note ? { note } : {}, opts())),
    setDirection: (id: string, patch: DirectionPatch) => wrap(api.put<ProjectIntel>(`/api/intel/projects/${enc(id)}/direction`, patch, opts())),
    addNote: (id: string, text: string) => wrap(api.post<NoteResult>(`/api/intel/projects/${enc(id)}/notes`, { text }, opts())),
    deleteNote: (noteId: string) => wrap(api.post<{ ok: true }>(`/api/intel/notes/${enc(noteId)}/delete`, {}, opts())),
  };
}

export function useIntelApi(): IntelApi {
  const api = useApi();
  return useMemo(() => intelApiOver(api), [api]);
}
