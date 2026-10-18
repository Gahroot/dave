import { useCallback, useRef, useState } from "react";
import type { MeetingItem } from "../../../../src/meetings/types.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { tick } from "../../ui/primitives";
import type { ItemAction } from "./model";

/** One status change at a time; never retried; reload after success or a 409. */
export function useItemAction(reload: () => unknown) {
  const api = useApi();
  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const onAction = useCallback(async (item: MeetingItem, action: ItemAction) => {
    if (lock.current) return;
    lock.current = true; setBusyId(item.id); setError("");
    try { await api.post(`/api/meetings/items/${encodeURIComponent(item.id)}/status`, { action }); tick(); void reload(); }
    catch (e) { setError(describeError(e)); void reload(); }
    finally { lock.current = false; setBusyId(null); }
  }, [api, reload]);
  return { busyId, error, onAction: (item: MeetingItem, action: ItemAction) => { void onAction(item, action); } };
}
