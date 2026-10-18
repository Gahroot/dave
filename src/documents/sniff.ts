/**
 * File type detection by magic bytes only. The client-declared type is never trusted; the file name only
 * narrows formats that have no reliable signature (DOCX inside a zip, plain text).
 */
import type { DocumentKind } from "../voice/types.ts";

export type Sniffed = { kind: DocumentKind; mime: string };

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const latin1 = (bytes: Uint8Array, start: number, end: number): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1", start, end);

const HEIF_BRANDS = new Set(["heic", "heix", "mif1", "msf1"]);
const TEXT_EXT = /\.(?:txt|md|csv)$/i;
const HTML_EXT = /\.html?$/i;

function validUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
function zipHasContentTypes(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes("[Content_Types].xml", 0, "latin1");
}
function looksHtml(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, Math.min(bytes.length, 1024)).replace(/^\u00ef\u00bb\u00bf/, "").replace(/^\s+/, "").toLowerCase();
  return head.startsWith("<!doctype html") || /^<html[\s>]/.test(head);
}

/** Returns null for anything that is not an accepted document type. */
export function sniffDocument(bytes: Uint8Array, name: string): Sniffed | null {
  if (startsWith(bytes, ascii("%PDF-"))) return { kind: "pdf", mime: "application/pdf" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return { kind: "image", mime: "image/gif" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { kind: "image", mime: "image/webp" };
  if (startsWith(bytes, ascii("ftyp"), 4) && bytes.length >= 12 && HEIF_BRANDS.has(latin1(bytes, 8, 12))) return { kind: "image", mime: "image/heic" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return /\.docx$/i.test(name) && zipHasContentTypes(bytes)
      ? { kind: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      : null;
  }
  if (startsWith(bytes, ascii("{\\rtf"))) return { kind: "rtf", mime: "application/rtf" };
  if (looksHtml(bytes) && validUtf8(bytes) !== null) return { kind: "html", mime: "text/html" };
  if (TEXT_EXT.test(name) || HTML_EXT.test(name)) {
    if (validUtf8(bytes) === null) return null;
    return HTML_EXT.test(name) ? { kind: "html", mime: "text/html" } : { kind: "text", mime: "text/plain" };
  }
  return null;
}
