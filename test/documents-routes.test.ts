import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { openDb } from "../src/db/index.ts";
import { createDocumentService } from "../src/documents/service.ts";
import type { DocumentService } from "../src/documents/types.ts";
import { registerDocumentRoutes } from "../src/server/document-routes.ts";
import { CSRF_HEADER, CSRF_PATH, GUARDED_BODY_LIMIT, localBrowserOrigins, registerRequestGuard, UPLOAD_BODY_LIMIT } from "../src/server/request-guard.ts";
import { NOW, tempDir } from "./helpers.ts";

const origin = "http://127.0.0.1:4317", host = "127.0.0.1:4317";
const apps: FastifyInstance[] = [], services: DocumentService[] = [], roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const s of services.splice(0)) await s.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const PDF = Buffer.from("%PDF-1.4\n%fixture\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function fixture(guardOptions?: { uploadBodyLimit?: number }) {
  const home = tempDir("dave-docroutes-"); roots.push(home);
  const app = Fastify(); apps.push(app);
  registerRequestGuard(app, localBrowserOrigins(4317), guardOptions);
  const docs = createDocumentService(openDb(home), home, { extractor: async () => ({ unavailable: true }), now: () => NOW, knownProject: (id) => id === "p1", projectName: () => "P1" });
  services.push(docs);
  registerDocumentRoutes(app, docs);
  app.post("/api/intel/dummy", async () => ({ ok: true }));
  const res = await app.inject({ url: CSRF_PATH, headers: { host, origin } });
  return { app, docs, csrf: res.json().token as string };
}
const upHeaders = (csrf: string, name = "plan.pdf") => ({ host, origin, [CSRF_HEADER]: csrf, "content-type": "application/octet-stream", "x-dave-filename": encodeURIComponent(name) });
const jsonHeaders = (csrf: string) => ({ host, origin, [CSRF_HEADER]: csrf, "content-type": "application/json" });

describe("document routes", () => {
  it("uploads raw bytes with CSRF and origin, deduping", async () => {
    const { app, csrf } = await fixture();
    const created = await app.inject({ method: "POST", url: "/api/files", headers: { ...upHeaders(csrf, "My plan ✓.pdf"), "x-dave-project": "p1" }, payload: PDF });
    expect(created.statusCode).toBe(201);
    expect(created.json().document).toMatchObject({ name: "My plan ✓.pdf", kind: "pdf", projectId: "p1", projectName: "P1" });
    const dup = await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: PDF });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);
    const list = await app.inject({ url: "/api/files?projectId=p1", headers: { host, origin } });
    expect(list.json().documents).toHaveLength(1);
    expect((await app.inject({ url: `/api/files/${created.json().document.id}`, headers: { host, origin } })).json().id).toBe(created.json().document.id);
    expect((await app.inject({ url: "/api/files/zzz", headers: { host, origin } })).statusCode).toBe(404);
  });

  it("requires CSRF, origin and a filename", async () => {
    const { app, csrf, docs } = await fixture();
    const h = upHeaders(csrf);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, [CSRF_HEADER]: "0".repeat(64) }, payload: PDF })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, origin: "https://evil.example" }, payload: PDF })).statusCode).toBe(403);
    const { origin: _o, ...noOrigin } = h;
    expect((await app.inject({ method: "POST", url: "/api/files", headers: noOrigin, payload: PDF })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, "sec-fetch-site": "cross-site" }, payload: PDF })).statusCode).toBe(403);
    const { "x-dave-filename": _n, ...noName } = h;
    expect((await app.inject({ method: "POST", url: "/api/files", headers: noName, payload: PDF })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, "x-dave-filename": "a".repeat(401) }, payload: PDF })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, "x-dave-filename": "%E0%A4%A" }, payload: PDF })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, "x-dave-project": "../x" }, payload: PDF })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...h, "x-dave-project": "nope" }, payload: PDF })).statusCode).toBe(404);
    expect(docs.list()).toHaveLength(0);
  });

  it("rejects JSON, compressed or empty uploads and disguised types", async () => {
    const { app, csrf } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...upHeaders(csrf), "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: { ...upHeaders(csrf), "content-encoding": "gzip" }, payload: PDF })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: Buffer.alloc(0) })).statusCode).toBe(400);
    const exe = await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, "invoice.pdf"), payload: Buffer.from("MZ\x90\x00binary", "latin1") });
    expect(exe.statusCode).toBe(415);
    expect(exe.json()).toEqual({ error: "Unsupported file type" });
    expect((await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, "x.txt"), payload: Buffer.from([0x61, 0, 0x62]) })).statusCode).toBe(415);
  });

  it("returns 413 above the upload limit (full 25 MB ceiling)", async () => {
    const { app, csrf } = await fixture();
    const res = await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: Buffer.alloc(UPLOAD_BODY_LIMIT + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "File is too large" });
  });

  it("accepts uploads well above the 64 KB JSON ceiling", async () => {
    const { app, csrf } = await fixture();
    const big = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 0x20)]);
    const res = await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, "big.pdf"), payload: big });
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ kind: "pdf", size: big.length });
  });

  it("an injected limit only lowers the ceiling", async () => {
    const { app, csrf } = await fixture({ uploadBodyLimit: 64 });
    expect((await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: Buffer.concat([PDF, Buffer.alloc(64)]) })).statusCode).toBe(413);
    expect((await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: PDF })).statusCode).toBe(201);
    expect(() => registerRequestGuard(Fastify(), localBrowserOrigins(4317), { uploadBodyLimit: 0 })).toThrow();
  });

  it("non-upload guarded routes still reject octet-stream and JSON over 64 KB", async () => {
    const { app, csrf } = await fixture();
    for (const url of ["/api/intel/dummy", "/api/files/0123456789abcdef/delete", "/api/files/0123456789abcdef/project"]) {
      const raw = await app.inject({ method: "POST", url, headers: { ...jsonHeaders(csrf), "content-type": "application/octet-stream" }, payload: PDF });
      expect(raw.statusCode).toBe(415);
      const big = await app.inject({ method: "POST", url, headers: jsonHeaders(csrf), payload: JSON.stringify({ x: "x".repeat(GUARDED_BODY_LIMIT) }) });
      expect(big.statusCode).toBe(413);
    }
  });

  it("serves content with safe headers, only for images and PDFs", async () => {
    const { app, csrf } = await fixture();
    const pdf = (await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, 'we"ird\r\n名.pdf'), payload: PDF })).json().document.id as string;
    const png = (await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, "shot.png"), payload: PNG })).json().document.id as string;
    const txt = (await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf, "n.txt"), payload: "hello" })).json().document.id as string;
    const a = await app.inject({ url: `/api/files/${pdf}/content`, headers: { host, origin } });
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toBe("application/pdf");
    expect(a.headers["x-content-type-options"]).toBe("nosniff");
    expect(a.headers["content-security-policy"]).toBe("sandbox");
    expect(a.headers["content-disposition"]).toBe('attachment; filename="weird.pdf"');
    expect(a.rawPayload).toEqual(PDF);
    const b = await app.inject({ url: `/api/files/${png}/content`, headers: { host, origin } });
    expect(b.headers["content-type"]).toBe("image/png");
    expect(b.headers["content-disposition"]).toBe('inline; filename="shot.png"');
    expect((await app.inject({ url: `/api/files/${txt}/content`, headers: { host, origin } })).statusCode).toBe(404);
  });

  it("validates project attach and delete bodies strictly", async () => {
    const { app, csrf } = await fixture();
    const id = (await app.inject({ method: "POST", url: "/api/files", headers: upHeaders(csrf), payload: PDF })).json().document.id as string;
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: jsonHeaders(csrf), payload: JSON.stringify(payload) });
    expect((await post(`/api/files/${id}/project`, { projectId: "p1" })).json().projectId).toBe("p1");
    expect((await post(`/api/files/${id}/project`, { projectId: null })).json().projectId).toBeNull();
    expect((await post(`/api/files/${id}/project`, { projectId: "nope" })).statusCode).toBe(404);
    expect((await post(`/api/files/${id}/project`, { projectId: 5 })).statusCode).toBe(400);
    expect((await post(`/api/files/${id}/project`, { projectId: "p1", extra: 1 })).statusCode).toBe(400);
    expect((await post(`/api/files/${id}/project`, {})).statusCode).toBe(400);
    expect((await post("/api/files/ffffffffffffffff/project", { projectId: null })).statusCode).toBe(404);
    expect((await post(`/api/files/${id}/delete`, { x: 1 })).statusCode).toBe(400);
    expect((await post(`/api/files/${id}/delete`, {})).json()).toEqual({ ok: true });
    expect((await post(`/api/files/${id}/delete`, {})).statusCode).toBe(404);
  });

  it("unguarded routes never parse octet-stream", async () => {
    const app = Fastify(); apps.push(app);
    registerRequestGuard(app, localBrowserOrigins(4317));
    app.post("/api/open", async () => ({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/api/open", headers: { "content-type": "application/octet-stream" }, payload: PDF });
    expect(res.statusCode).toBe(415);
  });
});
