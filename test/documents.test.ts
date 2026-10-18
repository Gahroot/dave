import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { sniffDocument } from "../src/documents/sniff.ts";
import { createDocumentService, DocumentError, sanitizeName } from "../src/documents/service.ts";
import type { ExtractResult, TextExtractor } from "../src/documents/types.ts";
import { LIMITS } from "../src/voice/types.ts";
import { NOW, tempDir } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const PDF = Buffer.from("%PDF-1.4\n%fixture\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const DOCX = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(26), Buffer.from("[Content_Types].xml<Types/>")]);
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(26), Buffer.from("payload.bin")]);
const EXE = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");

function setup(extractor?: TextExtractor, extra: { maxTotalBytes?: number } = {}) {
  const home = tempDir("dave-docs-"); roots.push(home);
  const db = openDb(home);
  const docs = createDocumentService(db, home, {
    extractor, now: () => NOW, knownProject: (id) => id === "p1", projectName: (id) => (id === "p1" ? "Project One" : null), ...extra,
  });
  return { home, db, docs, dir: path.join(home, "documents") };
}
const deferred = () => {
  let resolve: (v: ExtractResult) => void = () => undefined, reject: (e: Error) => void = () => undefined;
  const promise = new Promise<ExtractResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof DocumentError ? e.code : "other"; }
}

describe("sniffDocument", () => {
  it.each([
    [PDF, "a.pdf", "pdf", "application/pdf"],
    [PNG, "a.png", "image", "image/png"],
    [JPEG, "a.jpg", "image", "image/jpeg"],
    [Buffer.from("GIF89a...."), "a.gif", "image", "image/gif"],
    [Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "a.webp", "image", "image/webp"],
    [Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "latin1"), "a.heic", "image", "image/heic"],
    [Buffer.from("\0\0\0\x18ftypmif1\0\0\0\0", "latin1"), "a.heif", "image", "image/heic"],
    [DOCX, "contract.docx", "word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [Buffer.from("{\\rtf1\\ansi hi}"), "a.rtf", "rtf", "application/rtf"],
    [Buffer.from("\uFEFF  <!DOCTYPE HTML><p>x"), "page", "html", "text/html"],
    [Buffer.from("<html><body>x"), "x.bin", "html", "text/html"],
    [Buffer.from("<p>fragment</p>"), "frag.htm", "html", "text/html"],
    [Buffer.from("# Notes\nhello ✓"), "notes.md", "text", "text/plain"],
    [Buffer.from("a,b\n1,2"), "data.CSV", "text", "text/plain"],
  ])("detects %#", (bytes, name, kind, mime) => {
    expect(sniffDocument(bytes, name)).toEqual({ kind, mime });
  });
  it.each([
    [EXE, "invoice.pdf"], [ZIP, "contract.pdf"], [ZIP, "contract.docx"], [DOCX, "contract.zip"],
    [Buffer.from("plain words"), "notes.pdf"], [Buffer.from("plain words"), "noext"],
    [Buffer.from([0x61, 0x00, 0x62]), "nul.txt"], [Buffer.from([0xc3, 0x28]), "bad.txt"], [EXE, "run.txt"],
    [Buffer.from("#!/bin/sh\necho"), "script.sh"],
  ])("rejects disguised or unknown %#", (bytes, name) => {
    expect(sniffDocument(bytes, name)).toBeNull();
  });
  it("trusts bytes over the name: a PNG named .txt is an image", () => {
    expect(sniffDocument(PNG, "notes.txt")).toEqual({ kind: "image", mime: "image/png" });
  });
});

describe("sanitizeName", () => {
  it("keeps a display-safe basename", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("C:\\Users\\me\\Plan.pdf")).toBe("Plan.pdf");
    expect(sanitizeName("  a\u0000b\u001b[31m\u202e.pdf  ")).toBe("ab[31m.pdf");
    expect(sanitizeName("")).toBe("Untitled");
    expect(sanitizeName("dir/")).toBe("Untitled");
    expect(sanitizeName("..")).toBe("Untitled");
    expect([...sanitizeName("é".repeat(500))].length).toBe(200);
  });
});

describe("document service", () => {
  it("stores privately, dedupes by content and lists newest first", async () => {
    const { docs, dir } = setup(async () => ({ unavailable: true }));
    const first = await docs.upload({ name: "../secret/plan.pdf", bytes: PDF, projectId: "p1" });
    expect(first.duplicate).toBe(false);
    expect(first.document).toMatchObject({ name: "plan.pdf", kind: "pdf", size: PDF.length, textState: "pending", projectId: "p1", projectName: "Project One", createdAt: NOW.toISOString() });
    expect(first.document.id).toMatch(/^[a-f0-9]{16}$/);
    const file = path.join(dir, first.document.id);
    expect(fs.readFileSync(file)).toEqual(PDF);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const again = await docs.upload({ name: "copy.pdf", bytes: PDF, projectId: null });
    expect(again.duplicate).toBe(true);
    expect(again.document.id).toBe(first.document.id);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    const second = await docs.upload({ name: "pic.png", bytes: PNG, projectId: null });
    expect(docs.list().map((d) => d.id).sort()).toEqual([first.document.id, second.document.id].sort());
    expect(docs.list({ projectId: "p1" }).map((d) => d.id)).toEqual([first.document.id]);
    expect(docs.list({ projectId: null }).map((d) => d.id)).toEqual([second.document.id]);
    expect(docs.list({ limit: 1 })).toHaveLength(1);
    await docs.close();
  });

  it("enforces type, size, empty, quota and project rules", async () => {
    const { docs } = setup(async () => ({ unavailable: true }), { maxTotalBytes: 40 });
    expect(await code(docs.upload({ name: "x.pdf", bytes: EXE, projectId: null }))).toBe("unsupported");
    expect(await code(docs.upload({ name: "x.txt", bytes: Buffer.alloc(0), projectId: null }))).toBe("invalid");
    expect(await code(docs.upload({ name: "x.pdf", bytes: Buffer.alloc(LIMITS.uploadBytes + 1), projectId: null }))).toBe("too_large");
    expect(await code(docs.upload({ name: "x.pdf", bytes: PDF, projectId: "nope" }))).toBe("unknown_project");
    expect(await code(docs.upload({ name: "a.txt", bytes: Buffer.from("x".repeat(30)), projectId: null }))).toBe("ok");
    expect(await code(docs.upload({ name: "b.txt", bytes: Buffer.from("y".repeat(11)), projectId: null }))).toBe("quota");
    await docs.close();
  });

  it("drives text states through the extractor", async () => {
    const gates = { pdf: deferred(), image: deferred(), word: deferred() };
    const seen: string[] = [];
    const { docs, dir } = setup(async (file, signal) => {
      expect(path.dirname(file.path)).toBe(dir);
      expect(signal).toBeInstanceOf(AbortSignal);
      seen.push(file.kind);
      return gates[file.kind as keyof typeof gates].promise;
    });
    const pdf = await docs.upload({ name: "a.pdf", bytes: PDF, projectId: null });
    const img = await docs.upload({ name: "a.png", bytes: PNG, projectId: null });
    const word = await docs.upload({ name: "a.docx", bytes: DOCX, projectId: null });
    expect(docs.get(pdf.document.id)?.textState).toBe("pending");
    expect(docs.read(pdf.document.id)).toBeNull();
    gates.pdf.resolve({ text: "one\ftwo", pages: 2 });
    gates.image.resolve({ unavailable: true });
    gates.word.reject(new Error("SECRET_FAILURE_TEXT"));
    expect(await docs.settled(pdf.document.id)).toMatchObject({ textState: "ready", pages: 2, textChars: 7 });
    expect((await docs.settled(img.document.id))?.textState).toBe("unavailable");
    expect((await docs.settled(word.document.id))?.textState).toBe("failed");
    expect(seen.sort()).toEqual(["image", "pdf", "word"]);
    expect(await docs.settled("0".repeat(16))).toBeNull();
    await docs.close();
  });

  it("decodes text in-process, caps it, and reads windows, pages and offsets", async () => {
    let calls = 0;
    const big = "word ".repeat(90_000);
    const { docs } = setup(async () => { calls++; return { text: `page one\f${"pp ".repeat(2400)}\fend`, pages: 3 }; });
    const txt = await docs.upload({ name: "n.txt", bytes: Buffer.from(big), projectId: null });
    expect((await docs.settled(txt.document.id))?.textChars).toBe(400_000);
    expect(calls).toBe(0);
    const w1 = docs.read(txt.document.id);
    expect(w1).toMatchObject({ offset: 0, nextOffset: LIMITS.readWindowChars, page: null });
    expect(w1?.text).toHaveLength(LIMITS.readWindowChars);
    expect(docs.read(txt.document.id, { offset: 399_990, maxChars: 99_999 })).toMatchObject({ offset: 399_990, nextOffset: null });
    expect(docs.read(txt.document.id, { maxChars: 100_000 })?.text).toHaveLength(LIMITS.readWindowChars);
    expect(docs.read(txt.document.id, { maxChars: 10 })).toMatchObject({ nextOffset: 10 });

    const pdf = await docs.upload({ name: "a.pdf", bytes: PDF, projectId: null });
    await docs.settled(pdf.document.id);
    expect(docs.read(pdf.document.id, { page: 1 })).toMatchObject({ text: "page one", page: 1, pages: 3, nextOffset: null });
    const p2 = docs.read(pdf.document.id, { page: 2 });
    expect(p2).toMatchObject({ page: 2, offset: 0, nextOffset: 6000 });
    expect(docs.read(pdf.document.id, { page: 2, offset: 6000 })).toMatchObject({ offset: 6000, nextOffset: null });
    expect(docs.read(pdf.document.id, { page: 3 })?.text).toBe("end");
    expect(docs.read(pdf.document.id, { page: 9 })).toMatchObject({ text: "", nextOffset: null });
    await docs.close();
  });

  it("redacts secrets in read windows and finds agreement candidates", async () => {
    const { docs } = setup();
    const body = "Statement of work\n\nDeliverables:\n- Build the login page\n- Ship the billing export\n\napi_key = sk-live-abcdef1234567890abcdef1234567890\n";
    const up = await docs.upload({ name: "sow.md", bytes: Buffer.from(body), projectId: null });
    const ready = await docs.settled(up.document.id);
    expect(ready?.agreementCandidates).toBe(2);
    expect(docs.agreement(up.document.id)?.items.map((i) => i.title)).toEqual(["Build the login page", "Ship the billing export"]);
    const text = docs.read(up.document.id)?.text ?? "";
    expect(text).toContain("Build the login page");
    expect(text).not.toContain("abcdef1234567890abcdef1234567890");
    await docs.close();
  });

  it("serves content only for images and PDFs, attaches projects and removes files", async () => {
    const { docs, dir } = setup(async () => ({ unavailable: true }));
    const png = await docs.upload({ name: "a.png", bytes: PNG, projectId: null });
    const txt = await docs.upload({ name: "a.txt", bytes: Buffer.from("hello"), projectId: null });
    expect(docs.content(png.document.id)).toEqual({ bytes: PNG, mime: "image/png" });
    expect(docs.content(txt.document.id)).toBeNull();
    expect(docs.setProject(png.document.id, "p1")?.projectName).toBe("Project One");
    expect(() => docs.setProject(png.document.id, "zzz")).toThrow(DocumentError);
    expect(docs.setProject(png.document.id, null)?.projectId).toBeNull();
    expect(docs.setProject("f".repeat(16), null)).toBeNull();
    await docs.settled(png.document.id);
    expect(docs.remove(png.document.id)).toBe(true);
    expect(fs.existsSync(path.join(dir, png.document.id))).toBe(false);
    expect(docs.get(png.document.id)).toBeNull();
    expect(docs.remove(png.document.id)).toBe(false);
    fs.unlinkSync(path.join(dir, txt.document.id));
    expect(docs.remove(txt.document.id)).toBe(true);
    await docs.close();
  });

  it("never resolves a crafted id outside the documents directory", async () => {
    const { docs, db, home } = setup(async () => ({ unavailable: true }));
    fs.writeFileSync(path.join(home, "outside.png"), PNG);
    db.prepare(`INSERT INTO documents (id, project_id, name, kind, mime, size, sha256, pages, text_state, text, created_at, updated_at)
      VALUES ('../outside.png', NULL, 'x', 'image', 'image/png', 12, 'abc', NULL, 'ready', 'secret', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
    for (const id of ["../outside.png", "../../etc/passwd", "/etc/passwd", "ABCDEF0123456789", "0123456789abcdef/.."]) {
      expect(docs.get(id)).toBeNull();
      expect(docs.content(id)).toBeNull();
      expect(docs.read(id)).toBeNull();
      expect(docs.remove(id)).toBe(false);
    }
    expect(fs.existsSync(path.join(home, "outside.png"))).toBe(true);
    await docs.close();
  });

  it("close waits for in-flight extraction", async () => {
    const gate = deferred();
    const { docs } = setup(async () => gate.promise);
    const up = await docs.upload({ name: "a.pdf", bytes: PDF, projectId: null });
    let done = false;
    const closing = docs.close().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    gate.resolve({ text: "x", pages: 1 });
    await closing;
    expect(docs.get(up.document.id)?.textState).toBe("ready");
    expect(await code(docs.upload({ name: "b.png", bytes: PNG, projectId: null }))).toBe("invalid");
  });
});
