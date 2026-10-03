import { stream, type StreamOptions, type StreamEvent } from "@prestyj/ai";
import type { OpenAIAuth } from "./openai-auth.ts";

/** Delivery planning keeps its own stricter 64 KB checks; this ceiling protects every caller. */
export const MAX_INPUT_BYTES = 400_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_CACHE_KEY = "dave-delivery-v1";
/** Optional fields default to delivery planning's values, so existing callers are unchanged. */
export type InferenceRequest = { model: string; operationId: string; system: string; user: string; signal: AbortSignal; maxOutputBytes: number;
  timeoutMs?: number; cacheKey?: string };
export type PlanningInference = (request: InferenceRequest) => Promise<string>;
export type PlanningFailureCode = "unsupported_model" | "connection_required" | "provider_restricted" | "provider_error" | "output_limit" | "input_limit" | "cancelled" | "timeout" | "invalid_output" | "stale" | "save_failed" | "abandoned";
export class PlanningFailure extends Error {
  readonly code: PlanningFailureCode;
  constructor(code: PlanningFailureCode) { super(code); this.code = code; }
}
/** Server-only. Pass the process's shared auth instance; never instantiate auth per call.
 * @prestyj/ai 5.17.0 stream dispatches OpenAI to Codex ONLY with accountId.
 * No base URL/API key/environment transport overrides and no fallback are exposed.
 */
export function openAIInference(auth: Pick<OpenAIAuth, "getCredentials">,
  transport: (options: StreamOptions) => AsyncIterable<StreamEvent> & { response?: Promise<unknown> } = stream): PlanningInference {
  return async request => {
    if (request.model !== "gpt-6-astra") throw new PlanningFailure("unsupported_model");
    // Checked before credentials or network: an oversized request never leaves the machine.
    if (Buffer.byteLength(request.system) + Buffer.byteLength(request.user) > MAX_INPUT_BYTES) throw new PlanningFailure("input_limit");
    const timeoutMs = Number.isFinite(request.timeoutMs) ? Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const cacheKey = request.cacheKey !== undefined && /^[a-z0-9-]{1,64}$/.test(request.cacheKey) ? request.cacheKey : DEFAULT_CACHE_KEY;
    const controller = new AbortController();
    const abort = () => controller.abort(new PlanningFailure("cancelled"));
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new PlanningFailure("timeout")), timeoutMs);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    try {
      const work = (async () => {
        if (request.signal.aborted) throw new PlanningFailure("cancelled");
        const credentials = await auth.getCredentials().catch(() => { throw new PlanningFailure("connection_required"); });
        if (!credentials.accountId?.trim() || !credentials.accessToken || credentials.expiresAt <= Date.now()) throw new PlanningFailure("connection_required");
        if (controller.signal.aborted) throw new PlanningFailure("cancelled");
        let output = "", bytes = 0, done = false;
        const events = transport({ provider: "openai", model: request.model,
          apiKey: credentials.accessToken, accountId: credentials.accountId,
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
          tools: [], serverTools: [], toolChoice: "none", webSearch: false,
          signal: controller.signal, thinking: "low", maxTokens: 12000,
          promptCacheKey: cacheKey, transportSessionId: request.operationId,
        });
        // The library rejects both response and the iterator on failure. We use
        // the iterator; observe its companion promise to avoid an unhandled rejection.
        void events.response?.catch(() => {});
        for await (const event of events) {
          if (controller.signal.aborted) throw new PlanningFailure("cancelled");
          if (event.type === "error") throw event.error;
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            bytes += Buffer.byteLength(event.text);
            if (bytes > Math.min(request.maxOutputBytes, 64000)) throw new PlanningFailure("output_limit");
            if (event.type === "text_delta") output += event.text;
          } else if (event.type === "done") {
            if (event.stopReason !== "end_turn" && event.stopReason !== "stop_sequence") throw new PlanningFailure("provider_restricted");
            done = true;
          } else if (event.type !== "keepalive") throw new PlanningFailure("invalid_output");
        }
        if (!done) throw new PlanningFailure("provider_error");
        return output;
      })();
      return await Promise.race([work, aborted]);
    } catch (error) {
      if (error instanceof PlanningFailure) throw error;
      // Never reflect error.message, account data, headers or raw streaming errors.
      const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
      throw new PlanningFailure(status === 401 ? "connection_required" : status === 403 || status === 429 || status === 400 || status === 404 ? "provider_restricted" : "provider_error");
    } finally {
      clearTimeout(timer); controller.abort(); request.signal.removeEventListener("abort", abort);
    }
  };
}
