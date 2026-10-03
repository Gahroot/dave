import { useEffect } from "react";
import { parseRoute, safeReturn } from "../navigation.ts";

type Position = { route: string; key: string | null; y: number };
function position(value: unknown): Position | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<Position>;
  return typeof p.route === "string" && p.route.startsWith("#") &&
    (p.key === null || typeof p.key === "string") && typeof p.y === "number" && Number.isFinite(p.y)
    ? { route: p.route, key: p.key, y: Math.max(0, p.y) } : null;
}

/** Per-entry navigation geometry only; no drafts, persistent cache or polling. */
export function useWorkspaceReturn(route: string): void {
  useEffect(() => {
    const readReturns = () => {
      const stored = window.history.state?.workspaceReturns;
      return { inbox: position(stored?.inbox), projects: position(stored?.projects), request: position(stored?.request) };
    };
    let previousReturns = readReturns();
    let pending: { destination: string | null; origin: Position; saved: Position | null | undefined } | null = null;
    const carryReturns = () => {
      if (pending?.destination === window.location.hash) {
        window.history.replaceState({ ...window.history.state, workspaceOrigin: pending.origin, workspaceReturns: previousReturns, ...(pending.saved ? { workspacePosition: pending.saved } : {}) }, "");
      }
      pending = null;
      if (!window.history.state?.workspaceReturns) window.history.replaceState({ ...window.history.state, workspaceReturns: previousReturns }, "");
      previousReturns = readReturns();
    };
    const capture = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
      if (!link) return;
      const destination = link.getAttribute("href");
      const origin = position(window.history.state?.workspaceOrigin);
      if (link.hasAttribute("data-workspace-back") && origin && safeReturn(origin.route) === safeReturn(destination)) {
        event.preventDefault(); window.history.back(); return;
      }
      const current: Position = { route: window.location.hash || "#queue", key: link.dataset.workspaceFocus ?? null, y: window.scrollY };
      const returns = readReturns();
      const navigation = parseRoute(current.route);
      if (current.key && navigation.destination === "queue") returns[navigation.item || navigation.delivery ? "request" : "inbox"] = current;
      if (current.key && navigation.destination === "projects" && !navigation.id) returns.projects = current;
      previousReturns = returns;
      const backPosition = link.hasAttribute("data-workspace-back") ? Object.values(returns).find(p => p && safeReturn(p.route) === safeReturn(destination)) : null;
      window.history.replaceState({ ...window.history.state, workspacePosition: current, workspaceReturns: returns }, "");
      // A click microtask runs before the anchor's default navigation. Wait for the new entry.
      pending = { destination, origin: current, saved: backPosition };
    };
    document.addEventListener("click", capture);
    window.addEventListener("hashchange", carryReturns);
    return () => { document.removeEventListener("click", capture); window.removeEventListener("hashchange", carryReturns); };
  }, []);
  useEffect(() => {
    const saved = position(window.history.state?.workspacePosition);
    let frame = 0;
    const restore = (): boolean => {
      const target = saved && safeReturn(saved.route) === safeReturn(route || "#queue") && saved.key
        ? [...document.querySelectorAll<HTMLElement>("[data-workspace-focus]")].find(node => node.dataset.workspaceFocus === saved.key)
        : document.querySelector<HTMLElement>("[data-workspace-heading]");
      if (!target || !target.getClientRects().length) return false;
      frame = requestAnimationFrame(() => { target.focus({ preventScroll: true }); window.scrollTo(0, saved && safeReturn(saved.route) === safeReturn(route || "#queue") ? saved.y : 0); });
      return true;
    };
    if (restore()) return () => cancelAnimationFrame(frame);
    const observer = new MutationObserver(() => { if (restore()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);
    return () => { observer.disconnect(); clearTimeout(timeout); cancelAnimationFrame(frame); };
  }, [route]);
}
