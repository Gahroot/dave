import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 60_000;
const editing = () => !!document.querySelector("[data-intel-editing]") || !!document.activeElement?.closest("textarea, input, select");

/**
 * One owner for a read plus polling. Polling pauses with the app's pause switch and when the tab is hidden.
 * A background result never replaces what the user is editing: it waits as `pending` until applied.
 */
export function useIntelResource<T>(load: (signal: AbortSignal) => Promise<T>, key: string, paused: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);
  const background = useRef(false);

  useEffect(() => { setData(null); setPending(null); setError(null); setLoading(true); background.current = false; }, [key]);
  useEffect(() => {
    const ac = new AbortController();
    const bg = background.current;
    background.current = false;
    if (!bg) setLoading(true);
    void loadRef.current(ac.signal).then(next => {
      if (ac.signal.aborted) return;
      if (bg && editing()) setPending(next); else { setData(next); setPending(null); }
      setError(null); setLoading(false);
    }, (e: unknown) => { if (!ac.signal.aborted) { setError(e instanceof Error ? e.message : "Request failed. Retry."); setLoading(false); } });
    return () => ac.abort();
  }, [key, version]);
  useEffect(() => {
    if (paused) return;
    const tick = () => { if (document.visibilityState === "visible") { background.current = true; reload(); } };
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [paused, reload]);

  const applyPending = useCallback(() => { setPending(p => { if (p) setData(p); return null; }); }, []);
  return { data, setData, pending, applyPending, error, loading, reload };
}
