import { useEffect, useRef } from "react";

type Guard = { dirty: boolean; staysInScope: (hash: string) => boolean };
const guards = new Set<{ current: Guard }>();
let removeListeners: (() => void) | null = null;
function listen() {
  let approved: string | null = null;
  const wouldDiscard = (hash: string) => [...guards].some(({ current }) => current.dirty && !current.staysInScope(hash));
  const permits = (hash: string) => !wouldDiscard(hash) || window.confirm("Discard unsaved changes? Cancel keeps your draft.");
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest?.("a[href]");
    if (!anchor) return;
    const url = new URL(anchor.getAttribute("href")!, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash === location.hash) return;
    if (!permits(url.hash)) { event.preventDefault(); event.stopPropagation(); } else approved = url.hash;
  };
  const navigate = (event: HashChangeEvent) => {
    if (location.hash !== approved && !permits(location.hash)) { event.stopImmediatePropagation(); history.replaceState(null, "", new URL(event.oldURL).hash); return; }
    approved = null;
  };
  const unload = (event: BeforeUnloadEvent) => { if ([...guards].some(({ current }) => current.dirty)) { event.preventDefault(); event.returnValue = ""; } };
  document.addEventListener("click", click, true); window.addEventListener("hashchange", navigate, true); window.addEventListener("beforeunload", unload);
  return () => { document.removeEventListener("click", click, true); window.removeEventListener("hashchange", navigate, true); window.removeEventListener("beforeunload", unload); };
}
/** One confirmation for all React-owned private drafts; no browser persistence. */
export function useDraftGuard(dirty: boolean, staysInScope: (hash: string) => boolean) {
  const current = useRef({ dirty, staysInScope }); current.current = { dirty, staysInScope };
  useEffect(() => {
    guards.add(current); removeListeners ??= listen();
    return () => { guards.delete(current); if (!guards.size) { removeListeners?.(); removeListeners = null; } };
  }, []);
}
