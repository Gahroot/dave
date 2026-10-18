/**
 * Shared documents: stored under appHome/documents/<16 hex> (0600 files, 0700 dir), deduped by sha256, text
 * extracted once in the background right after upload. Uploaded bytes are never executed.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/index.ts";
import { parseAgreement } from "../intel/agreement.ts";
import type { ParsedAgreement } from "../intel/agreement.ts";
import { redactSecrets } from "../voice/safety.ts";
import { LIMITS } from "../voice/types.ts";
import type { DocumentKind, DocumentMeta, DocumentTextState, UploadResponse } from "../voice/types.ts";
import { decodeText, macTextExtractor } from "./extract.ts";
import { sniffDocument } from "./sniff.ts";
import type { DocumentErrorCode, DocumentReadOptions, DocumentReadResult, DocumentService, DocumentServiceOptions, ExtractResult } from "./types.ts";

export const MAX_TEXT_CHARS = 400_000;
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ID = /^[a-f0-9]{16}$/;

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DocumentError";
    this.code = code;
  }
}

type Row = {
  id: string; project_id: string | null; name: string; kind: DocumentKind; mime: string; size: number; sha256: string;
  pages: number | null; text_state: DocumentTextState; text: string | null; created_at: string; updated_at: string;
};

/** Display-only name: basename, no control characters, ≤200 chars, never empty. */
export function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  const cut = [...clean].slice(0, 200).join("").trim();
  return cut === "" || cut === "." || cut === ".." ? "Untitled" : cut;
}

export function createDocumentService(db: Db, appHome: string, options: DocumentServiceOptions = {}): DocumentService {
  const dir = path.resolve(appHome, "documents");
  const extractor = options.extractor ?? macTextExtractor;
  const now = options.now ?? (() => new Date());
  const projectName = options.projectName ?? (() => null);
  const knownProject = options.knownProject ?? (() => false);
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const inflight = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let closed = false;

  const filePath = (id: string): string => {
    if (!ID.test(id)) throw new DocumentError("not_found");
    const resolved = path.resolve(dir, id);
    if (path.dirname(resolved) !== dir) throw new DocumentError("not_found");
    return resolved;
  };
  const row = (id: string): Row | undefined =>
    ID.test(id) ? db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined : undefined;
  const meta = (r: Row): DocumentMeta => ({
    id: r.id, name: r.name, kind: r.kind, size: r.size, pages: r.pages, textState: r.text_state,
    projectId: r.project_id, projectName: r.project_id ? projectName(r.project_id) : null, createdAt: r.created_at,
    textChars: r.text_state === "ready" && r.text ? r.text.length : 0,
    agreementCandidates: r.text_state === "ready" && r.text ? parseAgreement(r.text).items.length : 0,
  });
  const checkProject = (projectId: string | null) => {
    if (projectId !== null && !knownProject(projectId)) throw new DocumentError("unknown_project");
  };
  const finish = (id: string, state: DocumentTextState, text: string | null, pages: number | null) => {
    db.prepare("UPDATE documents SET text_state = ?, text = ?, pages = ?, updated_at = ? WHERE id = ? AND text_state = 'pending'")
      .run(state, text, pages, now().toISOString(), id);
  };

  const extractInBackground = (id: string, kind: DocumentKind, bytes: Uint8Array) => {
    const job = (async () => {
      let result: ExtractResult;
      try {
        result = kind === "text" ? { text: decodeText(bytes), pages: null } : await extractor({ path: filePath(id), kind }, controller.signal);
      } catch {
        finish(id, "failed", null, null);
        return;
      }
      if ("unavailable" in result) { finish(id, "unavailable", null, null); return; }
      const text = result.text.replace(/\r\n?/g, "\n").slice(0, MAX_TEXT_CHARS);
      finish(id, "ready", text, result.pages);
    })().catch(() => undefined).finally(() => { inflight.delete(id); });
    inflight.set(id, job);
  };

  return {
    async upload({ name, bytes, projectId }): Promise<UploadResponse> {
      if (closed) throw new DocumentError("invalid", "Service closed");
      if (bytes.byteLength === 0) throw new DocumentError("invalid", "The file is empty");
      if (bytes.byteLength > LIMITS.uploadBytes) throw new DocumentError("too_large");
      const display = sanitizeName(name);
      const sniffed = sniffDocument(bytes, display);
      if (!sniffed) throw new DocumentError("unsupported");
      checkProject(projectId);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const existing = db.prepare("SELECT * FROM documents WHERE sha256 = ?").get(sha) as Row | undefined;
      if (existing) return { document: meta(existing), duplicate: true };
      const used = Number((db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM documents").get() as { total: number }).total);
      if (used + bytes.byteLength > maxTotal) throw new DocumentError("quota", "Document storage is full");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const id = randomBytes(8).toString("hex");
      const file = filePath(id);
      await fs.promises.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      const at = now().toISOString();
      try {
        db.prepare(`INSERT INTO documents (id, project_id, name, kind, mime, size, sha256, pages, text_state, text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`).run(id, projectId, display, sniffed.kind, sniffed.mime, bytes.byteLength, sha, at, at);
      } catch (error) {
        await fs.promises.unlink(file).catch(() => undefined);
        const raced = db.prepare("SELECT * FROM documents WHERE sha256 = ?").get(sha) as Row | undefined;
        if (raced) return { document: meta(raced), duplicate: true };
        throw error;
      }
      extractInBackground(id, sniffed.kind, bytes);
      const created = row(id);
      if (!created) throw new Error("Document vanished after insert");
      return { document: meta(created), duplicate: false };
    },
    list(filter = {}) {
      const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 200)));
      const rows = filter.projectId === undefined
        ? db.prepare("SELECT * FROM documents ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
        : filter.projectId === null
          ? db.prepare("SELECT * FROM documents WHERE project_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
          : db.prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(filter.projectId, limit);
      return (rows as Row[]).map(meta);
    },
    get(id) {
      const r = row(id);
      return r ? meta(r) : null;
    },
    async settled(id) {
      await inflight.get(id);
      return this.get(id);
    },
    read(id, opts: DocumentReadOptions = {}): DocumentReadResult | null {
      const r = row(id);
      if (!r || r.text_state !== "ready" || r.text === null) return null;
      const max = Math.max(1, Math.min(LIMITS.readWindowChars, Math.floor(opts.maxChars ?? LIMITS.readWindowChars)));
      let source = r.text, page: number | null = null;
      if (opts.page !== undefined) {
        const pages = r.text.split("\f");
        const n = Math.floor(opts.page);
        if (n < 1 || n > pages.length) return { document: meta(r), text: "", page: n, pages: r.pages, offset: 0, nextOffset: null };
        source = pages[n - 1] ?? "";
        page = n;
      }
      const offset = Math.max(0, Math.min(source.length, Math.floor(opts.offset ?? 0)));
      const end = Math.min(source.length, offset + max);
      return {
        document: meta(r), text: redactSecrets(source.slice(offset, end)), page, pages: r.pages, offset,
        nextOffset: end < source.length ? end : null,
      };
    },
    agreement(id): ParsedAgreement | null {
      const r = row(id);
      return r && r.text_state === "ready" && r.text !== null ? parseAgreement(r.text) : null;
    },
    content(id) {
      const r = row(id);
      if (!r || (r.kind !== "image" && r.kind !== "pdf")) return null;
      try {
        return { bytes: fs.readFileSync(filePath(r.id)), mime: r.mime };
      } catch { return null; }
    },
    setProject(id, projectId) {
      const r = row(id);
      if (!r) return null;
      checkProject(projectId);
      db.prepare("UPDATE documents SET project_id = ?, updated_at = ? WHERE id = ?").run(projectId, now().toISOString(), id);
      const updated = row(id);
      return updated ? meta(updated) : null;
    },
    remove(id) {
      const r = row(id);
      if (!r) return false;
      db.prepare("DELETE FROM documents WHERE id = ?").run(id);
      try { fs.unlinkSync(filePath(id)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return true;
    },
    async close() {
      closed = true;
      await Promise.all([...inflight.values()]);
    },
  };
}
