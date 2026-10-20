/**
 * The web's useIntelResource on the phone: one read plus a 60 s poll while the
 * screen is focused and the app is active. A background result never replaces
 * what the user is editing: it waits as `pending` until applied. Editors report
 * their dirty state with `useEditing(dirty)` inside an `EditingProvider`.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createElement } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { describeError } from "../../lib/api";

const POLL_MS = 60_000;

type EditingRegistry = { set(id: string, dirty: boolean): void; any(): boolean };
const EditingContext = createContext<EditingRegistry | null>(null);

export function useEditingRegistry(): EditingRegistry {
  const ref = useRef(new Set<string>());
  return useMemo(() => ({
    set: (id: string, dirty: boolean) => { if (dirty) ref.current.add(id); else ref.current.delete(id); },
    any: () => ref.current.size > 0,
  }), []);
}

export function EditingProvider({ registry, children }: { registry: EditingRegistry; children: ReactNode }) {
  return createElement(EditingContext.Provider, { value: registry }, children);
}

/** Marks this editor as holding unsaved input, so background polls wait. */
export function useEditing(dirty: boolean): void {
  const registry = useContext(EditingContext);
  const id = useId();
  useEffect(() => {
    registry?.set(id, dirty);
    return () => registry?.set(id, false);
  }, [registry, id, dirty]);
}

export function useIntelResource<T>(load: (signal: AbortSignal) => Promise<T>, key: string, editing: () => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const keyRef = useRef(key);
  keyRef.current = key;
  const controller = useRef<AbortController | null>(null);
  const focused = useRef(false);

  const fetchNow = useCallback((background: boolean, pulled = false) => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    const requested = keyRef.current;
    if (pulled) setRefreshing(true);
    void loadRef.current(ac.signal).then(next => {
      if (ac.signal.aborted || keyRef.current !== requested) return;
      if (background && editingRef.current()) setPending(next); else { setData(next); setPending(null); }
      setError(null);
    }, (e: unknown) => {
      if (!ac.signal.aborted && keyRef.current === requested) setError(describeError(e, "Request failed. Retry."));
    }).finally(() => {
      if (controller.current === ac) { controller.current = null; setLoading(false); setRefreshing(false); }
    });
  }, []);

  useEffect(() => {
    setData(null); setPending(null); setError(null); setLoading(true);
    return () => controller.current?.abort();
  }, [key]);

  // First load and every return to the screen; a return is background so drafts survive.
  const loaded = useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    const first = loaded.current !== key;
    loaded.current = key;
    fetchNow(!first);
    return () => { focused.current = false; };
  }, [fetchNow, key]));

  useEffect(() => {
    const timer = setInterval(() => { if (focused.current && AppState.currentState === "active") fetchNow(true); }, POLL_MS);
    const sub = AppState.addEventListener("change", next => { if (next === "active" && focused.current) fetchNow(true); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [fetchNow]);

  const reload = useCallback(() => fetchNow(false), [fetchNow]);
  const pull = useCallback(() => fetchNow(true, true), [fetchNow]);
  const applyPending = useCallback(() => { setPending(p => { if (p) setData(p); return null; }); }, []);
  return { data, setData, pending, applyPending, error, loading, refreshing, reload, pull };
}
