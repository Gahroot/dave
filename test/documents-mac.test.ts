import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { macTextExtractor } from "../src/documents/extract.ts";
import { createDocumentService } from "../src/documents/service.ts";
import { tempDir } from "./helpers.ts";

const darwin = process.platform === "darwin";
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Fixture maker only (test side): draws a multi-page PDF or a PNG with text using AppKit. */
const MAKE = `ObjC.import('AppKit'); ObjC.import('PDFKit');
function run(argv) {
  const out = argv[0], kind = argv[1], texts = argv.slice(2);
  if (kind === 'pdf') {
    const doc = $.PDFDocument.alloc.init;
    texts.forEach((t, i) => {
      const v = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 612, 792));
      v.string = $(t); v.font = $.NSFont.systemFontOfSize(18);
      doc.insertPageAtIndex($.PDFDocument.alloc.initWithData(v.dataWithPDFInsideRect(v.bounds)).pageAtIndex(0), i);
    });
    return doc.writeToFile($(out)) ? 'ok' : 'fail';
  }
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(900, 200));
  img.lockFocus;
  $.NSColor.whiteColor.setFill; $.NSRectFill($.NSMakeRect(0, 0, 900, 200));
  $(texts[0]).drawAtPointWithAttributes($.NSMakePoint(20, 80), $.NSDictionary.dictionaryWithObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName));
  img.unlockFocus;
  const png = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return png.writeToFileAtomically($(out), true) ? 'ok' : 'fail';
}`;

describe("macTextExtractor (darwin only)", () => {
  it.runIf(darwin)("extracts PDF pages, OCRs a PNG, converts DOCX/RTF/HTML through the service", async () => {
    const work = tempDir("dave-macx-"), home = tempDir("dave-machome-"); roots.push(work, home);
    const make = (out: string, ...args: string[]) => execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAKE, out, ...args]);
    make(path.join(work, "a.pdf"), "pdf", "Statement of Work page one", "Second page deliverables");
    make(path.join(work, "a.png"), "png", "Invoice total 4200 dollars");
    fs.writeFileSync(path.join(work, "a.html"), "<html><body><h1>Scope</h1><ul><li>Build login page</li></ul></body></html>");
    for (const fmt of ["docx", "rtf"]) execFileSync("/usr/bin/textutil", ["-convert", fmt, path.join(work, "a.html"), "-output", path.join(work, `a.${fmt}`)]);

    const docs = createDocumentService(openDb(home), home, { extractor: macTextExtractor });
    const up = async (name: string) => {
      const res = await docs.upload({ name, bytes: fs.readFileSync(path.join(work, name)), projectId: null });
      return docs.settled(res.document.id);
    };
    const pdf = await up("a.pdf");
    expect(pdf).toMatchObject({ kind: "pdf", textState: "ready", pages: 2 });
    expect(docs.read(pdf?.id ?? "", { page: 2 })?.text).toContain("Second page deliverables");
    expect(docs.read(pdf?.id ?? "", { page: 1 })?.text).toContain("Statement of Work page one");
    const png = await up("a.png");
    expect(png).toMatchObject({ kind: "image", textState: "ready" });
    expect(docs.read(png?.id ?? "")?.text).toContain("Invoice total 4200");
    for (const name of ["a.docx", "a.rtf", "a.html"]) {
      const doc = await up(name);
      expect(doc?.textState).toBe("ready");
      expect(docs.read(doc?.id ?? "")?.text).toContain("Build login page");
    }
    await docs.close();
  }, 60_000);

  it.runIf(darwin)("refuses paths outside a documents directory", async () => {
    await expect(macTextExtractor({ path: "/etc/hosts", kind: "rtf" }, new AbortController().signal)).rejects.toThrow();
  });
});
