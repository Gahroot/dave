/**
 * Shared documents: the server-side contract between the document service (src/documents/service.ts),
 * its routes (src/server/document-routes.ts) and voice tools (src/voice/tools.ts).
 * Uploaded bytes are stored under appHome/documents, never executed; text is extracted only on upload.
 */
import type { ParsedAgreement } from "../intel/agreement.ts";
import type { DocumentKind, DocumentMeta, UploadResponse } from "../voice/types.ts";

export type ExtractResult = { text: string; pages: number | null } | { unavailable: true };
/** `path` is always inside appHome/documents. Injected in tests; macTextExtractor on darwin. */
export type TextExtractor = (file: { path: string; kind: DocumentKind }, signal: AbortSignal) => Promise<ExtractResult>;

export type DocumentErrorCode = "unsupported" | "too_large" | "quota" | "invalid" | "not_found" | "unknown_project";

export type DocumentServiceOptions = {
  extractor?: TextExtractor;
  now?: () => Date;
  /** Display name for a project id, null when unknown. */
  projectName?: (id: string) => string | null;
  /** Whether a project id may be attached to a document. */
  knownProject?: (id: string) => boolean;
  /** Total stored bytes cap (default 1 GB). */
  maxTotalBytes?: number;
};

export type DocumentReadOptions = { page?: number; offset?: number; maxChars?: number };
/** A window of extracted text, already secret-redacted. PDF pages are separated by \f in storage. */
export type DocumentReadResult = {
  document: DocumentMeta;
  text: string;
  /** The 1-based page read, null when reading by offset. */
  page: number | null;
  pages: number | null;
  offset: number;
  /** null when the end was reached. */
  nextOffset: number | null;
};

export type DocumentService = {
  /** Rejects with DocumentError (code above) for unsupported types, oversize, quota or an unknown project. */
  upload(input: { name: string; bytes: Uint8Array; projectId: string | null }): Promise<UploadResponse>;
  list(filter?: { projectId?: string | null; limit?: number }): DocumentMeta[];
  get(id: string): DocumentMeta | null;
  /** Resolves once text extraction for this document has finished (or immediately). null when unknown. */
  settled(id: string): Promise<DocumentMeta | null>;
  /** null when unknown or the text is not ready. */
  read(id: string, options?: DocumentReadOptions): DocumentReadResult | null;
  agreement(id: string): ParsedAgreement | null;
  /** Images and PDFs only; null otherwise. */
  content(id: string): { bytes: Buffer; mime: string } | null;
  setProject(id: string, projectId: string | null): DocumentMeta | null;
  remove(id: string): boolean;
  /** Waits for in-flight extraction, then stops accepting work. */
  close(): Promise<void>;
};
