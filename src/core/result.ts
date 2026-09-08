import type { PortfolioIssue } from "../shared/types.ts";

/**
 * Every adapter returns data plus non-fatal issues. One broken project or one
 * unreadable file must never fail the whole portfolio.
 */
export type Result<T> = { data: T; issues: PortfolioIssue[] };

export function ok<T>(data: T, issues: PortfolioIssue[] = []): Result<T> {
  return { data, issues };
}

export function issue(
  adapter: string,
  message: string,
  path: string | null = null,
  observedAt = new Date().toISOString(),
): PortfolioIssue {
  return { adapter, path, message, observedAt };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Runs an adapter, converting any throw into an issue plus a fallback value. */
export async function safeAsync<T>(
  adapter: string,
  fallback: T,
  fn: () => Promise<Result<T>> | Result<T>,
  path: string | null = null,
): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    return { data: fallback, issues: [issue(adapter, errorMessage(e), path)] };
  }
}
