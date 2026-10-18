/**
 * macOS text extraction with fixed system binaries and argument arrays (never a shell). The file path is passed as
 * an argv argument (read through `run(argv)` in JXA), never interpolated into a script. Uploaded bytes are only ever
 * read by these converters; nothing uploaded is executed. Runs only on upload, never during portfolio refresh.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DocumentKind } from "../voice/types.ts";
import type { ExtractResult, TextExtractor } from "./types.ts";

export const EXTRACT_TIMEOUT_MS = 30_000;
export const EXTRACT_MAX_BUFFER = 6 * 1024 * 1024;
const TEXTUTIL = "/usr/bin/textutil";
const OSASCRIPT = "/usr/bin/osascript";

const PDF_SCRIPT = `ObjC.import('Foundation'); ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(argv[0])));
  if (!doc || doc.isNil()) throw new Error('unreadable');
  const n = Number(doc.pageCount); const out = [];
  for (let i = 0; i < n; i++) { const s = doc.pageAtIndex(i).string; out.push(s && !s.isNil() ? ObjC.unwrap(s) : ''); }
  return JSON.stringify({ pages: n, text: out.join('\\f') });
}`;

const OCR_SCRIPT = `ObjC.import('Foundation'); ObjC.import('Vision');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.usesLanguageCorrection = true;
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath($(argv[0])), $.NSDictionary.dictionary);
  if (!handler.performRequestsError($.NSArray.arrayWithObject(req), $())) throw new Error('vision failed');
  const results = req.results; const lines = [];
  const n = !results || results.isNil() ? 0 : Number(results.count);
  for (let i = 0; i < n; i++) { const c = results.objectAtIndex(i).topCandidates(1); if (Number(c.count) > 0) lines.push(ObjC.unwrap(c.objectAtIndex(0).string)); }
  return JSON.stringify({ pages: null, text: lines.join('\\n') });
}`;

/** The documents directory a path must live in: `<appHome>/documents/<16 hex>`. */
export function insideDocumentsDir(file: string): boolean {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  return path.basename(dir) === "documents" && /^[a-f0-9]{16}$/.test(path.basename(resolved));
}

function run(file: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { PATH: "/usr/bin:/bin" }, timeout: EXTRACT_TIMEOUT_MS, maxBuffer: EXTRACT_MAX_BUFFER, signal, encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(new Error("Extraction failed")) : resolve(stdout)));
  });
}

function parseJxa(stdout: string): { text: string; pages: number | null } {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null) throw new Error("Extraction failed");
  const { text, pages } = value as { text?: unknown; pages?: unknown };
  if (typeof text !== "string") throw new Error("Extraction failed");
  const n = Number(pages);
  return { text, pages: pages === null || !Number.isInteger(n) || n < 0 ? null : n };
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

async function extract(file: { path: string; kind: DocumentKind }, signal: AbortSignal): Promise<ExtractResult> {
  if (!insideDocumentsDir(file.path)) throw new Error("Path outside the documents directory");
  if (file.kind === "text") return { text: decodeText(await fs.promises.readFile(file.path, { signal })), pages: null };
  if (process.platform !== "darwin") return { unavailable: true };
  const target = path.resolve(file.path);
  switch (file.kind) {
    case "word": case "rtf": case "html":
      return { text: await run(TEXTUTIL, ["-convert", "txt", "-stdout", target], signal), pages: null };
    case "pdf":
      return parseJxa(await run(OSASCRIPT, ["-l", "JavaScript", "-e", PDF_SCRIPT, target], signal));
    case "image":
      return parseJxa(await run(OSASCRIPT, ["-l", "JavaScript", "-e", OCR_SCRIPT, target], signal));
  }
}

export const macTextExtractor: TextExtractor = extract;
