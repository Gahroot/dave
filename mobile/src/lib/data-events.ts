/**
 * "Data changed" notices inside the phone app, mirroring the web's
 * `dave:data-changed` window event (src/voice/types.ts DATA_CHANGED_EVENT).
 * Voice tools and bulk actions announce which scopes they changed; every
 * mounted `useResource` whose path belongs to a changed scope reloads.
 *
 *   announceDataChanged(["meetings", "intel"]);
 *   const stop = onDataChanged((scopes) => { … });
 */
import type { DataScope } from "../../../src/voice/types.ts";

export type { DataScope };
type Listener = (scopes: readonly DataScope[]) => void;
const listeners = new Set<Listener>();

export function announceDataChanged(scopes: readonly DataScope[]): void {
  if (scopes.length === 0) return;
  for (const listener of [...listeners]) {
    try { listener(scopes); } catch { /* one screen's failure must not stop the others */ }
  }
}

export function onDataChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Which scope an API path's data belongs to (null: refreshed only on focus and polling). */
export function scopeOfPath(path: string): DataScope | null {
  if (/^\/api\/(portfolio|projects|attention|today|refresh)(\/|\?|$)/.test(path)) return "portfolio";
  if (/^\/api\/(intel|delivery)(\/|\?|$)/.test(path)) return "intel";
  if (/^\/api\/(meetings|triage)(\/|\?|$)/.test(path)) return "meetings";
  if (/^\/api\/files(\/|\?|$)/.test(path)) return "documents";
  return null;
}
