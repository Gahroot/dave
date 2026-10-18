/**
 * GET /api/providers response (src/providers/index.ts `status()`), restated
 * here because importing that module's types drags server-only Node code into
 * the phone's typecheck.
 */
export type LoginOperation = { id: string; status: "pending" | "success" | "error" | "cancelled"; error: string | null; message: string | null };
export type ProviderStatus = {
  openai: { provider: "openai"; storage: "keychain" | "session"; state: "disconnected" | "connecting" | "connected" | "reconnect_required"; error: string | null; models: string[] };
  claude: { provider: "claude"; state: "unavailable"; models: readonly string[]; error: string };
  operation: LoginOperation | null;
};
