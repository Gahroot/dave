import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { registerRequestGuard, localBrowserOrigins, CSRF_HEADER, CSRF_PATH, GUARDED_BODY_LIMIT } from "../src/server/request-guard.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { tempDir } from "./helpers.ts";

const origin = "http://127.0.0.1:4317", host = "127.0.0.1:4317";
const apps: FastifyInstance[] = [], roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(origins = localBrowserOrigins(4317)) {
  const app = Fastify(); apps.push(app);
  registerRequestGuard(app, origins);
  let handled = 0;
  app.get("/api/providers", async () => ({ connected: false }));
  app.post("/api/providers/connect", async (req) => { handled++; return { accepted: req.body }; });
  app.post("/api/projects/:id/delivery/goal", async () => { handled++; return { ok: true }; });
  app.post("/api/providers/failure", async () => { throw new Error("SYNTHETIC_PROVIDER_SECRET"); });
  app.post("/api/providers/small", { bodyLimit: 16 }, async () => { handled++; return { ok: true }; });
  app.post("/api/providers/large", { bodyLimit: 1024 * 1024 }, async () => { handled++; return { ok: true }; });
  app.register(async (child) => {
    child.post("/:id/delivery/generate", async () => { handled++; return { ok: true }; });
  }, { prefix: "/api/projects" });
  return { app, handled: () => handled };
}
async function token(app: FastifyInstance, requestedOrigin = origin) {
  const res = await app.inject({ url: CSRF_PATH, headers: { host: new URL(requestedOrigin).host, origin: requestedOrigin } });
  expect(res.statusCode).toBe(200);
  expect(res.json().token).toMatch(/^[a-f0-9]{64}$/);
  return res.json().token as string;
}
const headers = (csrf: string) => ({ host, origin, [CSRF_HEADER]: csrf, "content-type": "application/json" });

describe("local provider/planning request boundary", () => {
  it("accepts configured same-origin requests and same-origin browser token fetches", async () => {
    const { app, handled } = fixture();
    const bootstrap = await app.inject({ url: CSRF_PATH, headers: { host, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.headers["x-content-type-options"]).toBe("nosniff");
    expect(bootstrap.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(bootstrap.headers["access-control-allow-origin"]).toBeUndefined();
    const csrf = await token(app);
    expect(bootstrap.json().token).toBe(csrf);
    for (const url of ["/api/providers/connect", "/api/projects/fixture/delivery/goal", "/api/projects/fixture/delivery/generate"]) {
      const res = await app.inject({ method: "POST", url, headers: headers(csrf), payload: { goal: "Synthetic workflow" } });
      expect(res.statusCode).toBe(200);
    }
    expect(handled()).toBe(3);
    expect((await app.inject({ url: "/api/providers", headers: { host, origin } })).statusCode).toBe(200);
  });

  it.each(["evil.example:4317", "127.0.0.1.evil.example:4317", "localhost.evil.example:4317", "0.0.0.0:4317", "127.1:4317", "localhost:9999", "127.0.0.1"])("rejects unconfigured Host %s without trusting forwarded headers", async (badHost) => {
    const { app, handled } = fixture(), csrf = await token(app);
    const res = await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), host: badHost, "x-forwarded-host": host, "x-forwarded-proto": "http" }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(handled()).toBe(0);
    expect(res.body).not.toContain(csrf);
  });

  it.each(["null", "https://evil.example", "http://localhost:4317", "http://127.0.0.1:4318", origin + "/", origin + "/private", origin + "#fragment"])("rejects mismatched/malformed Origin %s", async (badOrigin) => {
    const { app, handled } = fixture(), csrf = await token(app);
    const res = await app.inject({ method: "POST", url: "/api/projects/id/delivery/goal", headers: { ...headers(csrf), origin: badOrigin }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(handled()).toBe(0);
    expect((await app.inject({ url: CSRF_PATH, headers: { host, origin: badOrigin } })).statusCode).toBe(403);
  });

  it("rejects missing Origin/Fetch Metadata, cross-site fetches and navigations", async () => {
    const { app, handled } = fixture(), csrf = await token(app);
    expect((await app.inject({ url: CSRF_PATH, headers: { host } })).statusCode).toBe(403);
    for (const extra of [
      { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" }, { "sec-fetch-dest": "script" }, { "sec-fetch-mode": "navigate" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), ...extra }, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    const missingOrigin = { host, [CSRF_HEADER]: csrf, "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: missingOrigin, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...missingOrigin, "sec-fetch-site": "same-origin" }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/projects/id/delivery/generate", headers: { host, origin }, payload: {} })).statusCode).toBe(403);
    expect(handled()).toBe(0);
  });

  it("rejects missing/invalid tokens and tokens from other origins or server instances", async () => {
    const { app, handled } = fixture(), other = fixture();
    const otherToken = await token(other.app);
    const aliasToken = await token(app, "http://localhost:4317");
    for (const csrf of ["", "invalid", "0".repeat(64), "a".repeat(1000), otherToken, aliasToken]) {
      const res = await app.inject({ method: "POST", url: "/api/providers/connect", headers: headers(csrf), payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('{"error":"Missing or invalid CSRF token"}');
    }
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: { host, origin, "content-type": "application/json" }, payload: {} })).statusCode).toBe(403);
    expect(handled()).toBe(0);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/json; charset=latin1", "application/json; unexpected=true"])("rejects non-JSON/unsupported content type %s", async (contentType) => {
    const { app, handled } = fixture(), csrf = await token(app);
    const res = await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), "content-type": contentType }, payload: "{}" });
    expect(res.statusCode).toBe(415);
    expect(handled()).toBe(0);
  });

  it("rejects compressed input and accepts UTF-8 JSON", async () => {
    const { app, handled } = fixture(), csrf = await token(app);
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), "content-encoding": "gzip" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), "content-type": "application/json; charset=utf-8" }, payload: "{}" })).statusCode).toBe(200);
    expect(handled()).toBe(1);
  });

  it.each(["{invalid SYNTHETIC_BODY_SECRET", "", "null", "[]", "42", '"string"', '{"__proto__":{"polluted":true}}'])("rejects malformed/non-object JSON without echoing its contents: %s", async (payload) => {
    const { app, handled } = fixture(), csrf = await token(app);
    const res = await app.inject({ method: "POST", url: "/api/providers/connect", headers: headers(csrf), payload });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("SYNTHETIC_BODY_SECRET");
    expect(res.body).not.toContain("polluted");
    expect(handled()).toBe(0);
  });

  it("enforces byte limits and preserves tighter route limits", async () => {
    const { app, handled } = fixture(), csrf = await token(app);
    for (const [url, payload] of [
      ["/api/providers/connect", JSON.stringify({ text: "x".repeat(GUARDED_BODY_LIMIT) })],
      ["/api/providers/large", JSON.stringify({ text: "x".repeat(GUARDED_BODY_LIMIT) })],
      ["/api/providers/connect", JSON.stringify({ text: "💡".repeat(GUARDED_BODY_LIMIT / 3) })],
      ["/api/providers/small", JSON.stringify({ text: "x".repeat(16) })],
    ]) {
      const res = await app.inject({ method: "POST", url: url!, headers: headers(csrf), payload: payload! });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: "Request body is too large" });
    }
    expect(handled()).toBe(0);
  });

  it("caps chunked bodies without trusting a Content-Length header", async () => {
    const { app, handled } = fixture(), csrf = await token(app);
    const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: address.port, path: "/api/providers/connect", method: "POST", headers: headers(csrf), timeout: 5000 }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("Fixture request timed out")));
      req.on("error", reject);
      req.write('{"text":"'); req.write("x".repeat(40000)); req.end("x".repeat(40000) + '"}');
    });
    expect(result).toEqual({ status: 413, body: '{"error":"Request body is too large"}' });
    expect(handled()).toBe(0);
  });

  it("redacts thrown provider errors rather than reflecting secrets", async () => {
    const { app } = fixture(), csrf = await token(app);
    const res = await app.inject({ method: "POST", url: "/api/providers/failure", headers: headers(csrf), payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Request failed" });
    expect(res.body).not.toContain("SYNTHETIC_PROVIDER_SECRET");
  });

  it("supports explicitly configured dev proxies but rejects arbitrary origin configuration", async () => {
    for (const invalid of ["https://localhost:4317", "http://evil.example:4317", "http://localhost:4317/path", "http://user:pass@localhost:4317", "http://0.0.0.0:4317"]) {
      const app = Fastify(); apps.push(app);
      expect(() => registerRequestGuard(app, [invalid])).toThrow("loopback");
    }
    expect(localBrowserOrigins(80)).toEqual(["http://127.0.0.1", "http://localhost"]);
    expect(() => localBrowserOrigins(0)).toThrow("port");
    const devOrigin = "http://localhost:5173";
    const { app } = fixture([devOrigin]), csrf = await token(app, devOrigin);
    expect((await app.inject({ method: "POST", url: "/api/providers/connect", headers: { ...headers(csrf), host: "localhost:5173", origin: devOrigin }, payload: {} })).statusCode).toBe(200);
  });

  it("installs in the real server without requiring new headers from existing clients", async () => {
    const root = tempDir("dave-guard-"); roots.push(root);
    const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
    const app = await buildServer(paths, { browserOrigins: [origin] }); apps.push(app);
    app.post("/api/projects/:id/delivery/probe", async () => ({ ok: true }));
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    const csrf = await token(app);
    expect((await app.inject({ method: "POST", url: "/api/projects/fixture/delivery/probe", headers: { host, origin }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/projects/fixture/delivery/probe", headers: headers(csrf), payload: {} })).statusCode).toBe(200);
  });
});
