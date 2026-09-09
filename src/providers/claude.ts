/** Deliberate fail-closed integration, per the approved isolation exception.
 * No CLI process, auth-file access or API-billing fallback exists here.
 * See docs/provider-integration.md before replacing this boundary.
 */
export const CLAUDE_ISOLATION_BLOCKER = "Claude planning is unavailable: subscription-compatible isolation from managed hooks has not been verified.";
export const CLAUDE_MODELS = ["claude-fable-5-1", "claude-opus-5"] as const;

export function claudeStatus() {
  return { provider: "claude" as const, state: "unavailable" as const,
    models: CLAUDE_MODELS, error: CLAUDE_ISOLATION_BLOCKER };
}

export function requireClaudePlanning(): never {
  throw new Error(CLAUDE_ISOLATION_BLOCKER);
}
