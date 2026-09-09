import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const GUARDED_BODY_LIMIT = 64 * 1024;
export const CSRF_HEADER = "x-dave-csrf";
export const CSRF_PATH = "/api/security/csrf";

/** Explicit origins, never inferred from untrusted Host/Forwarded headers. */
export function localBrowserOrigins(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local server port");
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].map((value) => new URL(value).origin);
}
function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.origin === value;
  } catch { return false; }
}
function guardedRoute(url: string): boolean {
  return url === CSRF_PATH || /^\/api\/providers(?:\/|$)/.test(url) ||
    /^\/api\/projects\/[^/]+\/delivery(?:\/|$)/.test(url);
}
function fail(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}
function singleHeader(req: FastifyRequest, name: string): string | undefined {
  // Node may discard a duplicate Host; inspecting raw headers avoids accepting it.
  let count = 0;
  for (let i = 0; i < req.raw.rawHeaders.length; i += 2) {
    if (req.raw.rawHeaders[i]?.toLowerCase() === name) count++;
  }
  const value = req.headers[name];
  return count > 1 || typeof value !== "string" ? undefined : value;
}

/** Register before routes. Existing portfolio clients are unchanged; the new
 * provider/delivery namespaces always inherit these controls, including nested
 * plugins and routes declared after registration. Tokens are per server/origin,
 * never persisted, logged, or shared with a provider. Restart requires refetch.
 */
export function registerRequestGuard(app: FastifyInstance, origins: string[]): void {
  if (origins.length === 0 || origins.length > 12 || !origins.every(validOrigin)) {
    throw new Error("Configure explicit HTTP loopback browser origins");
  }
  const tokens = new Map([...new Set(origins)].map((origin) => [origin, randomBytes(32).toString("hex")]));
  const hosts = new Map([...tokens.keys()].map((origin) => [new URL(origin).host, origin]));
  const requestOrigin = (req: FastifyRequest) => hosts.get(singleHeader(req, "host") ?? "");

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    const expected = requestOrigin(req);
    if (!expected) return fail(reply, 403, "Request host is not allowed");
    const origin = singleHeader(req, "origin");
    const site = singleHeader(req, "sec-fetch-site");
    if ((req.headers.origin !== undefined && origin !== expected) ||
        (req.headers["sec-fetch-site"] !== undefined && site !== "same-origin")) {
      return fail(reply, 403, "Same-origin request required");
    }
    // Browser same-origin GETs often omit Origin. Fetch Metadata is acceptable
    // for reads; non-browser clients can supply the exact configured Origin.
    const read = req.method === "GET" || req.method === "HEAD";
    if (origin !== expected && (!read || site !== "same-origin")) return fail(reply, 403, "Same-origin request required");
    if ((req.headers["sec-fetch-dest"] !== undefined && singleHeader(req, "sec-fetch-dest") !== "empty") ||
        (req.headers["sec-fetch-mode"] !== undefined && !["cors", "same-origin"].includes(singleHeader(req, "sec-fetch-mode") ?? ""))) {
      return fail(reply, 403, "Fetch request required");
    }
    if (req.method === "GET" || req.method === "HEAD") return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return fail(reply, 405, "Method is not allowed");
    const token = singleHeader(req, CSRF_HEADER);
    const expectedToken = tokens.get(expected)!;
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
      return fail(reply, 403, "Missing or invalid CSRF token");
    }
    const contentType = singleHeader(req, "content-type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(contentType) ||
        (req.headers["content-encoding"] !== undefined && singleHeader(req, "content-encoding") !== "identity")) {
      return fail(reply, 415, "An uncompressed application/json body is required");
    }
  };
  app.addHook("onRoute", (route) => {
    if (!guardedRoute(route.url)) return;
    // Route-local smaller limits remain valid; no route can raise this ceiling.
    route.bodyLimit = Math.min(route.bodyLimit ?? GUARDED_BODY_LIMIT, GUARDED_BODY_LIMIT);
    const existing = route.onRequest ? (Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest]) : [];
    route.onRequest = [guard, ...existing];
    const validation = route.preValidation ? (Array.isArray(route.preValidation) ? route.preValidation : [route.preValidation]) : [];
    route.preValidation = [async (req, reply) => {
      if (req.method === "GET" || req.method === "HEAD") return;
      if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
        return fail(reply, 400, "A JSON object is required");
      }
    }, ...validation];
    // Parser/schema exceptions may contain pasted credentials or provider text.
    // Do not echo or log those exceptions, even on a route with a custom handler.
    route.errorHandler = (error, _req, reply) => {
      const status = error.statusCode;
      const messages: Record<number, string> = {
        400: "Invalid request body", 401: "Connection required", 403: "Request forbidden",
        404: "Not found", 409: "State changed; reload and retry", 413: "Request body is too large",
        415: "An uncompressed application/json body is required", 429: "Too many requests", 503: "Service unavailable",
      };
      return fail(reply, status && messages[status] ? status : 500, status && messages[status] ? messages[status]! : "Request failed");
    };
  });
  app.get(CSRF_PATH, async (req) => ({ token: tokens.get(requestOrigin(req)!) }));
  app.addHook("onClose", async () => { tokens.clear(); hosts.clear(); });
}
