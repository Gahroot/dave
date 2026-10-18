import { randomBytes } from "node:crypto";
import type { ConfirmCard } from "./types.ts";

export const CONFIRM_TTL_MS = 120_000;

type Pending<T> = { sessionId: string; toolName: string; action: T; card: ConfirmCard; expiresMs: number };
export type TakeResult<T> = { ok: true; toolName: string; action: T; card: ConfirmCard } | { ok: false; reason: "unknown" | "expired" | "wrong_session" | "wrong_tool" };

/** Writes waiting for "yes". In memory only; single-use, session-bound tokens with a 120 s TTL. */
export function confirmStore<T>(now: () => Date, ttlMs = CONFIRM_TTL_MS) {
  const pending = new Map<string, Pending<T>>();
  const sweep = () => { const t = now().getTime(); for (const [k, v] of pending) if (v.expiresMs <= t) pending.delete(k); };
  return {
    prepare(sessionId: string, toolName: string, action: T, say: string, title: string, details: string[]): ConfirmCard {
      sweep();
      const token = randomBytes(16).toString("hex");
      const expiresMs = now().getTime() + ttlMs;
      const card: ConfirmCard = { token, title, say, details, expiresAt: new Date(expiresMs).toISOString() };
      pending.set(token, { sessionId, toolName, action, card, expiresMs });
      return card;
    },
    take(sessionId: string, token: string, toolName?: string): TakeResult<T> {
      const p = pending.get(token);
      if (!p) return { ok: false, reason: "unknown" };
      if (p.sessionId !== sessionId) return { ok: false, reason: "wrong_session" };
      if (toolName !== undefined && p.toolName !== toolName) return { ok: false, reason: "wrong_tool" };
      pending.delete(token);
      if (p.expiresMs <= now().getTime()) return { ok: false, reason: "expired" };
      return { ok: true, toolName: p.toolName, action: p.action, card: p.card };
    },
    dropSession(sessionId: string): void { for (const [k, v] of pending) if (v.sessionId === sessionId) pending.delete(k); },
    clear(): void { pending.clear(); },
  };
}
export type ConfirmStore<T> = ReturnType<typeof confirmStore<T>>;
