/**
 * Read one API resource for a screen.
 *
 *   const { data, error, loading, refreshing, reload, setData } =
 *     useResource<Portfolio>("/api/portfolio", { pollMs: 60_000 });
 *
 * Loads when the screen gains focus (stale-while-revalidate: existing data
 * stays on screen), polls only while focused and the app is active, and
 * ignores answers for a path that is no longer current. `path: null` waits.
 * Pull-to-refresh: `<RefreshControl refreshing={refreshing} onRefresh={reload} />`.
 * Also reloads when `announceDataChanged` (./data-events) names this path's scope.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { describeError } from "./api";
import { useApi } from "./connection";
import { onDataChanged, scopeOfPath } from "./data-events";

export type Resource<T> = {
  data: T | null;
  error: string | null;
  /** First load with nothing to show yet. */
  loading: boolean;
  /** A reload while data is already on screen. */
  refreshing: boolean;
  reload(): Promise<void>;
  /** Replace data locally, e.g. with a mutation's returned state. */
  setData(next: T | null | ((current: T | null) => T | null)): void;
};

export function useResource<T>(path: string | null, options: { pollMs?: number; timeoutMs?: number } = {}): Resource<T> {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const current = useRef(path);
  current.current = path;
  const inFlight = useRef<Promise<void> | null>(null);
  const focused = useRef(false);
  const hasData = useRef(false);

  const reload = useCallback((): Promise<void> => {
    const requested = current.current;
    if (requested === null) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    if (hasData.current) setRefreshing(true); else setLoading(true);
    const run = (async () => {
      try {
        const next = await api.get<T>(requested, { timeoutMs: options.timeoutMs });
        if (current.current !== requested) return;
        hasData.current = true;
        setData(next);
        setError(null);
      } catch (e) {
        if (current.current === requested) setError(describeError(e));
      } finally {
        inFlight.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, options.timeoutMs]);

  // A new path starts empty rather than showing another item's data.
  useEffect(() => {
    hasData.current = false;
    setData(null);
    setError(null);
    setLoading(path !== null);
    inFlight.current = null;
  }, [path]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void reload();
    return () => { focused.current = false; };
  }, [reload, path]));

  useEffect(() => {
    if (!options.pollMs || path === null) return;
    const timer = setInterval(() => {
      if (focused.current && AppState.currentState === "active") void reload();
    }, Math.max(2_000, options.pollMs));
    const subscription = AppState.addEventListener("change", (next) => { if (next === "active" && focused.current) void reload(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [options.pollMs, path, reload]);

  // Reload when voice or a bulk action reports a change to this path's data.
  useEffect(() => {
    const scope = path === null ? null : scopeOfPath(path);
    if (scope === null) return;
    return onDataChanged((scopes) => { if (scopes.includes(scope)) void reload(); });
  }, [path, reload]);

  const set = useCallback((next: T | null | ((value: T | null) => T | null)) => {
    setData((value) => {
      const resolved = typeof next === "function" ? (next as (v: T | null) => T | null)(value) : next;
      hasData.current = resolved !== null;
      return resolved;
    });
  }, []);

  return { data, error, loading, refreshing, reload, setData: set };
}
