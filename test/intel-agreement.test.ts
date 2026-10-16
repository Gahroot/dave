import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGREEMENT_MAX_CHARS, parseAgreement } from "../src/intel/agreement.ts";

const lines = (...xs: string[]) => xs.join("\n");

describe("agreement parser", () => {
  it("captures deliverables with sub-bullet detail, skips stop sections and collects acceptance lines", () => {
    const parsed = parseAgreement(lines(
      "# Statement of Work",
      "Intro text that is not a list.",
      "## Deliverables",
      "- Online booking form for patients;",
      "  - Shows free slots for the next 4 weeks",
      "  - Sends a confirmation email",
      "- Staff calendar view.",
      "- [ ] **Reminder emails**",
      "## Out of scope",
      "- Native mobile apps",
      "## Acceptance criteria",
      "- A patient can book a free slot without calling",
      "- Staff see new bookings within a minute",
      "## Payment terms",
      "- 50% upfront",
    ));
    expect(parsed.items).toEqual([
      { title: "Online booking form for patients", detail: "Shows free slots for the next 4 weeks; Sends a confirmation email", section: "Deliverables" },
      { title: "Staff calendar view", detail: null, section: "Deliverables" },
      { title: "Reminder emails", detail: null, section: "Deliverables" },
    ]);
    expect(parsed.acceptance).toEqual(["A patient can book a free slot without calling", "Staff see new bookings within a minute"]);
  });

  it("reads ALL-CAPS and numbered headings, and tells a numbered heading from a numbered deliverable", () => {
    const parsed = parseAgreement(lines(
      "SCOPE OF WORK",
      "1. Patient portal with login",
      "2. Admin dashboard",
      "3. Payment Terms",
      "- Net 30",
      "FEATURES",
      "* Export bookings to CSV",
    ));
    expect(parsed.items.map((i) => [i.title, i.section])).toEqual([
      ["Patient portal with login", "SCOPE OF WORK"],
      ["Admin dashboard", "SCOPE OF WORK"],
      ["Export bookings to CSV", "FEATURES"],
    ]);
  });

  it("an unnamed sub-heading stays inside the section above it", () => {
    const parsed = parseAgreement(lines("## Scope", "The supplier will build:", "- Booking form", "- Calendar view"));
    expect(parsed.items.map((i) => [i.title, i.section])).toEqual([["Booking form", "Scope"], ["Calendar view", "Scope"]]);
  });

  it("falls back to every bullet outside stop sections when no heading names the scope", () => {
    const parsed = parseAgreement(lines("Hi Sam,", "Here is what we agreed:", "- Booking form", "- Calendar view", "Exclusions:", "- Mobile app", "Thanks"));
    expect(parsed.items.map((i) => i.title)).toEqual(["Booking form", "Calendar view"]);
    expect(parsed.acceptance).toEqual([]);
  });

  it("removes duplicates, honours the item cap, and caps long titles", () => {
    const text = lines("## Deliverables", "- Booking form", "- booking  FORM", "- Calendar", `- ${"Long ".repeat(80)}`);
    expect(parseAgreement(text).items.map((i) => i.title.slice(0, 20))).toEqual(["Booking form", "Calendar", "Long Long Long Long "]);
    expect(parseAgreement(text, 1).items).toHaveLength(1);
    const long = parseAgreement(text).items[2]?.title ?? "";
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("deduplicates acceptance lines and keeps at most 20", () => {
    const accept = Array.from({ length: 25 }, (_, n) => `- Check number ${n + 1}`);
    const parsed = parseAgreement(lines("## Acceptance", "- Check number 1", ...accept));
    expect(parsed.acceptance).toHaveLength(20);
    expect(parsed.acceptance[0]).toBe("Check number 1");
    expect(parsed.acceptance[1]).toBe("Check number 2");
  });

  it("ignores text past the input cap and returns nothing for empty input", () => {
    expect(parseAgreement(lines("## Deliverables", "x".repeat(AGREEMENT_MAX_CHARS), "- Hidden item")).items).toEqual([]);
    expect(parseAgreement("")).toEqual({ items: [], acceptance: [] });
  });

  it("has zero imports, so the browser can run it and pasted text never leaves the page", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../src/intel/agreement.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(import|export\s+\*\s+from|export\s+\{[^}]*\}\s+from)\b/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
