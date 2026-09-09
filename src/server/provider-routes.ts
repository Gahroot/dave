import type { FastifyInstance } from "fastify";
import { OpenAIAuthError } from "../providers/openai-auth.ts";
import type { ProviderService } from "../providers/index.ts";
import type { OpenAIStorageMode } from "../providers/types.ts";

export function strictObject(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw Object.assign(new Error("Invalid request"), { statusCode: 400 });
}
export function registerProviderRoutes(app: FastifyInstance, service: ProviderService) {
  app.get("/api/providers", async () => service.status());
  app.get<{ Params: { operationId: string } }>("/api/providers/openai/operations/:operationId", async (req, reply) => {
    const op = service.status().operation;
    return op?.id === req.params.operationId ? op : reply.code(404).send({ error: "Unknown operation" });
  });
  for (const action of ["connect", "restore", "disconnect", "cancel"] as const) {
    app.post(`/api/providers/openai/${action}`, async (req, reply) => {
      strictObject(req.body, action === "connect" || action === "restore" ? ["storage"] : action === "cancel" ? ["operationId"] : []);
      try {
        if (action === "connect" || action === "restore") {
          if (!["keychain", "session"].includes(req.body.storage as string)) return reply.code(400).send({ error: "Invalid storage mode" });
          if (action === "connect") {
            const operation = service.connect(req.body.storage as OpenAIStorageMode);
            return reply.code(202).send({ operationId: operation.id, operation });
          }
          service.restore(req.body.storage as OpenAIStorageMode);
        } else if (action === "cancel") {
          if (typeof req.body.operationId !== "string" || !service.cancel(req.body.operationId)) return reply.code(404).send({ error: "Unknown operation" });
        } else service.disconnect();
        return service.status();
      } catch (error) {
        const safe = error instanceof OpenAIAuthError ? new OpenAIAuthError(error.code) : new OpenAIAuthError("network_error");
        return reply.code(safe.code === "login_busy" ? 409 : 503).send({ error: safe.code, message: safe.message });
      }
    });
  }
}
