import type { FastifyInstance, FastifyReply } from "fastify";
import { DocumentError } from "../documents/service.ts";
import type { DocumentErrorCode, DocumentService } from "../documents/types.ts";
import { strictObject } from "./provider-routes.ts";

const PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DOC_ID = /^[a-f0-9]{16}$/;
const ERRORS: Record<DocumentErrorCode, [number, string]> = {
  unsupported: [415, "Unsupported file type"],
  too_large: [413, "File is too large"],
  quota: [413, "Document storage is full; delete some files first"],
  invalid: [400, "Invalid file"],
  not_found: [404, "Not found"],
  unknown_project: [404, "Unknown project"],
};

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof DocumentError) {
    const [status, message] = ERRORS[error.code];
    return reply.code(status).send({ error: message });
  }
  throw error;
}
function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/** A safe ASCII filename for Content-Disposition. */
function asciiName(name: string, fallback: string): string {
  const clean = name.normalize("NFKD").replace(/[^A-Za-z0-9._ -]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return clean === "" || /^\.+$/.test(clean) ? fallback : clean;
}

export function registerDocumentRoutes(app: FastifyInstance, documents: DocumentService): void {
  app.post("/api/files", { config: { upload: true } }, async (req, reply) => {
    const rawName = header(req.headers["x-dave-filename"]);
    if (rawName === undefined || rawName.length === 0 || rawName.length > 400) return reply.code(400).send({ error: "A file name is required" });
    let name: string;
    try { name = decodeURIComponent(rawName); } catch { return reply.code(400).send({ error: "A file name is required" }); }
    const rawProject = header(req.headers["x-dave-project"]);
    if (rawProject !== undefined && !PROJECT_ID.test(rawProject)) return reply.code(400).send({ error: "Invalid project" });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "A file body is required" });
    try {
      const result = await documents.upload({ name, bytes: req.body, projectId: rawProject ?? null });
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) { return sendError(reply, error); }
  });
  app.get<{ Querystring: { projectId?: string } }>("/api/files", async (req, reply) => {
    const projectId = req.query.projectId;
    if (projectId !== undefined && (typeof projectId !== "string" || !PROJECT_ID.test(projectId))) return reply.code(400).send({ error: "Invalid project" });
    return { documents: documents.list(projectId === undefined ? {} : { projectId }) };
  });
  app.get<{ Params: { id: string } }>("/api/files/:id", async (req, reply) => {
    const doc = DOC_ID.test(req.params.id) ? documents.get(req.params.id) : null;
    return doc ?? reply.code(404).send({ error: "Not found" });
  });
  app.get<{ Params: { id: string } }>("/api/files/:id/content", async (req, reply) => {
    const doc = DOC_ID.test(req.params.id) ? documents.get(req.params.id) : null;
    const content = doc ? documents.content(doc.id) : null;
    if (!doc || !content) return reply.code(404).send({ error: "Not found" });
    const pdf = content.mime === "application/pdf";
    const filename = asciiName(doc.name, pdf ? "document.pdf" : "image");
    return reply
      .header("Content-Type", content.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Content-Disposition", `${pdf ? "attachment" : "inline"}; filename="${filename}"`)
      .send(content.bytes);
  });
  app.post<{ Params: { id: string } }>("/api/files/:id/project", async (req, reply) => {
    strictObject(req.body, ["projectId"]);
    const projectId = req.body.projectId;
    if (projectId !== null && (typeof projectId !== "string" || !PROJECT_ID.test(projectId))) return reply.code(400).send({ error: "Invalid project" });
    if (!DOC_ID.test(req.params.id)) return reply.code(404).send({ error: "Not found" });
    try {
      const doc = documents.setProject(req.params.id, projectId);
      return doc ?? reply.code(404).send({ error: "Not found" });
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/api/files/:id/delete", async (req, reply) => {
    strictObject(req.body, []);
    if (!DOC_ID.test(req.params.id) || !documents.remove(req.params.id)) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });
}
