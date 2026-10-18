/**
 * The portfolio snapshot many screens need (projects, inbox, issues).
 * Same endpoint and freshness as the web App: GET /api/portfolio, re-read
 * every 60 s while visible; POST /api/refresh forces a rescan.
 */
import type { Portfolio, PortfolioProject } from "../../../src/shared/types.ts";
import { useResource, type Resource } from "./useResource";

export function usePortfolio(): Resource<Portfolio> {
  return useResource<Portfolio>("/api/portfolio", { pollMs: 60_000 });
}

export function allProjects(portfolio: Portfolio | null): PortfolioProject[] {
  return portfolio ? [...portfolio.active, ...portfolio.other, ...portfolio.hidden] : [];
}

export function findProject(portfolio: Portfolio | null, id: string | null | undefined): PortfolioProject | null {
  return id ? allProjects(portfolio).find((p) => p.id === id) ?? null : null;
}

/** Route ids follow the web's identifier rule (src/ui/navigation.ts). */
export function routeId(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one && /^[a-zA-Z0-9_-]{1,200}$/.test(one) ? one : null;
}
