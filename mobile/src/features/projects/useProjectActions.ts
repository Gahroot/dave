/** App.tsx's overrideProject and correctSummary for the phone. Never retried automatically. */
import { useCallback, useRef, useState } from "react";
import type { Portfolio, ProjectSummary } from "../../../../src/shared/types.ts";
import { ApiError, describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import type { Resource } from "../../lib/useResource";
import { patchSummary, type NoteKey } from "./model";

export type SaveResult = { ok: true; summary: ProjectSummary } | { ok: false; error: string };

export function useProjectActions(resource: Resource<Portfolio>) {
  const api = useApi();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const { reload, setData } = resource;

  const override = useCallback(async (id: string, next: { pinned?: boolean; hidden?: boolean }): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true; setBusyId(id); setError(null);
    try {
      await api.post(`/api/projects/${encodeURIComponent(id)}/override`, next);
      await reload();
      return true;
    } catch (e) {
      setError(describeError(e, "Action failed"));
      if (e instanceof ApiError && e.status === 409) void reload();
      return false;
    } finally { saving.current = false; setBusyId(null); }
  }, [api, reload]);

  const correct = useCallback(async (id: string, field: NoteKey, value: string): Promise<SaveResult> => {
    if (saving.current) return { ok: false, error: "Another change is saving. Retry when it finishes." };
    saving.current = true; setBusyId(id); setError(null);
    try {
      const { summary } = await api.post<{ summary: ProjectSummary }>(`/api/projects/${encodeURIComponent(id)}/summary`, { [field]: value });
      setData((current) => current ? patchSummary(current, id, summary) : current);
      void reload();
      return { ok: true, summary };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) void reload();
      return { ok: false, error: describeError(e, "Save failed") };
    } finally { saving.current = false; setBusyId(null); }
  }, [api, reload, setData]);

  return { busyId, error, clearError: () => setError(null), override, correct };
}
