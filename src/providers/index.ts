import { randomUUID } from "node:crypto";
import { OpenAIAuth, OpenAIAuthError } from "./openai-auth.ts";
import { openAIInference, PlanningFailure, type PlanningInference } from "./openai.ts";
import { claudeStatus } from "./claude.ts";
import type { OpenAIStorageMode } from "./types.ts";

export type LoginOperation = { id: string; status: "pending" | "success" | "error" | "cancelled"; error: string | null; message: string | null };
export type OwnedAuth = Pick<OpenAIAuth, "status" | "restore" | "connect" | "cancel" | "disconnect" | "dispose" | "getCredentials">;
/** One owner per server process. Construction/status are storage- and network-free.
 * Switching modes disposes memory, never disconnects/deletes persisted Keychain credentials. */
export function createProviderService(deps: { authFactory?: (mode: OpenAIStorageMode) => OwnedAuth; inference?: PlanningInference } = {}) {
  let mode: OpenAIStorageMode = "keychain", auth: OwnedAuth | undefined, operation: LoginOperation | null = null;
  const owner = () => auth ??= (deps.authFactory ?? (m => new OpenAIAuth(m)))(mode);
  function select(next: OpenAIStorageMode) {
    if (next !== "keychain" && next !== "session") throw new OpenAIAuthError("storage_unavailable");
    if (operation?.status === "pending") throw new OpenAIAuthError("login_busy");
    if (mode !== next) { auth?.dispose(); auth = undefined; mode = next; }
  }
  const inference: PlanningInference = request => {
    if (request.model !== "gpt-6-astra") throw new PlanningFailure("unsupported_model");
    return deps.inference ? deps.inference(request) : openAIInference(owner())(request);
  };
  return {
    inference,
    status() {
      const raw = auth?.status();
      const state = raw && ["disconnected", "connecting", "connected", "reconnect_required"].includes(raw.state) ? raw.state : "disconnected";
      const error = raw?.error && ["storage_unavailable", "invalid_credentials", "reconnect_required", "network_error", "invalid_response", "login_busy", "port_unavailable", "browser_error", "cancelled", "login_timeout", "provider_denied"].includes(raw.error) ? raw.error : null;
      return { openai: { provider: "openai", storage: mode, state, error, models: ["gpt-6-astra"], limits: { maxContextBytes: 64000, maxOutputBytes: 64000, timeoutMs: 120000 } }, claude: claudeStatus(), operation: operation ? { ...operation } : null };
    },
    connect(storage: OpenAIStorageMode) {
      if (operation?.status === "pending") { if (storage !== mode) throw new OpenAIAuthError("login_busy"); return { ...operation }; }
      select(storage);
      const instance = owner();
      const current: LoginOperation = { id: randomUUID(), status: "pending", error: null, message: null }; operation = current;
      void Promise.resolve().then(() => { if (current.status === "pending") return instance.connect(); }).then(() => { if (current.status === "pending") current.status = "success"; }, error => {
        if (current.status !== "pending") return;
        const safe = error instanceof OpenAIAuthError ? new OpenAIAuthError(error.code) : new OpenAIAuthError("network_error");
        current.status = "error"; current.error = safe.code; current.message = safe.message;
      });
      return { ...current };
    },
    restore(storage: OpenAIStorageMode) { select(storage); owner().restore(); },
    cancel(id: string) { if (operation?.id !== id) return false; if (operation.status === "pending") { operation.status = "cancelled"; auth?.cancel(); } return true; },
    disconnect() { if (operation?.status === "pending") { operation.status = "cancelled"; auth?.cancel(); } owner().disconnect(); },
    close() { if (operation?.status === "pending") operation.status = "cancelled"; auth?.dispose(); auth = undefined; },
  };
}
export type ProviderService = ReturnType<typeof createProviderService>;
let singleton: ProviderService | undefined;
export function providerService(): ProviderService { return singleton ??= createProviderService(); }
