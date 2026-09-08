import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import {
  isContentlessRequest,
  readSessionSummaries,
  stripBoilerplate,
} from "../src/adapters/session-summary.ts";
import { tempDir, writeText } from "./helpers.ts";

const dir = tempDir("pcc-sess-");

function sessionFile(name: string, records: unknown[]) {
  writeText(path.join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

beforeAll(() => {
  sessionFile("2026-09-01T10-00-00Z_a.jsonl", [
    { type: "session", timestamp: "2026-09-01T10:00:00.000Z", cwd: "/p/alpha" },
    { type: "message", message: { role: "user", content: "add pagination to the invoice list" } },
  ]);
  sessionFile("2026-09-02T10-00-00Z_b.jsonl", [
    { type: "session", timestamp: "2026-09-02T10:00:00.000Z", cwd: "/p/alpha" },
    {
      type: "message",
      message: {
        role: "user",
        content:
          "[Autopilot] This turn was triggered by Nolan, EZ Coder's automated reviewer — not by a human.\n- Prove your work before finishing: run the tests.\n\nYour instruction:\n\nfix the CSV export encoding",
      },
    },
    { kind: "run_failed", type: "custom" },
  ]);
  sessionFile("2026-09-03T10-00-00Z_c.jsonl", [
    { type: "session", timestamp: "2026-09-03T10:00:00.000Z", cwd: "/p/alpha" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "split the billing module" }] } },
  ]);
});

describe("stripBoilerplate", () => {
  it("removes an autopilot preamble and keeps the real instruction", () => {
    const text = stripBoilerplate(
      "[Autopilot] This turn was triggered by Nolan, EZ Coder's automated reviewer.\n- Prove your work before finishing.\n\nYour instruction:\n\nrename the billing service",
    );
    expect(text).toBe("rename the billing service");
  });

  it("removes a restored conversation summary", () => {
    const text = stripBoilerplate(
      "[Previous conversation summary] we did lots of things\nand more things\n\n### Next step\nwire the export screen",
    );
    expect(text).not.toContain("Previous conversation summary");
    expect(text).toContain("wire the export screen");
  });

  it("removes system reminders and status updates", () => {
    expect(stripBoilerplate("<system-reminder>be careful</system-reminder>\nreal work here")).toBe("real work here");
    expect(stripBoilerplate("[Status update on background work you started. blah]\nreal work")).toBe("real work");
  });

  it("leaves an ordinary request untouched", () => {
    expect(stripBoilerplate("make the dashboard load faster")).toBe("make the dashboard load faster");
  });

  it("never returns empty for a message that was all scaffolding", () => {
    expect(stripBoilerplate("[Autopilot] Prove your work before finishing.").length).toBeGreaterThan(0);
  });
});

describe("isContentlessRequest", () => {
  it("rejects a bare go-ahead that describes no work", () => {
    for (const text of [
      "The plan has been approved. Implement it now, following each step in order.",
      "go ahead",
      "yes",
      "ok",
      "approved",
      "ship it",
    ]) {
      expect(isContentlessRequest(text)).toBe(true);
    }
  });

  it("keeps a request that names actual work", () => {
    for (const text of [
      "add pagination to the invoice list",
      "the plan is approved but skip the migration step for now",
      "fix the CSV export encoding",
    ]) {
      expect(isContentlessRequest(text)).toBe(false);
    }
  });
});

describe("readSessionSummaries", () => {
  it("returns the newest sessions first with their opening request", async () => {
    const { data } = await readSessionSummaries(dir);
    expect(data[0]!.request).toBe("split the billing module");
    expect(data[0]!.startedAt).toBe("2026-09-03T10:00:00.000Z");
  });

  it("strips harness scaffolding out of the recorded request", async () => {
    const { data } = await readSessionSummaries(dir);
    const b = data.find((s) => s.file.includes("_b.jsonl"))!;
    expect(b.request).toBe("fix the CSV export encoding");
    expect(b.request).not.toMatch(/Autopilot|Nolan/);
  });

  it("detects a failed run", async () => {
    const { data } = await readSessionSummaries(dir);
    expect(data.find((s) => s.file.includes("_b.jsonl"))!.failed).toBe(true);
    expect(data.find((s) => s.file.includes("_a.jsonl"))!.failed).toBe(false);
  });

  it("reads text content given as an array of parts", async () => {
    const { data } = await readSessionSummaries(dir);
    expect(data.find((s) => s.file.includes("_c.jsonl"))!.request).toBe("split the billing module");
  });

  it("caps how many sessions it opens", async () => {
    const { data } = await readSessionSummaries(dir, 2);
    expect(data).toHaveLength(2);
  });

  it("survives a redirect stub with no request", async () => {
    const stubDir = tempDir("pcc-stub-");
    writeText(
      path.join(stubDir, "2026-09-01T10-00-00Z_x.jsonl"),
      JSON.stringify({ type: "gg_session_redirect", version: 1, target: "x.jsonl.gz" }) + "\n",
    );
    const { data } = await readSessionSummaries(stubDir);
    expect(data[0]!.request).toBeNull();
  });

  it("skips a contentless request so an older informative one wins", async () => {
    const d = tempDir("pcc-goahead-");
    writeText(
      path.join(d, "2026-09-01T10-00-00Z_old.jsonl"),
      [
        JSON.stringify({ type: "session", timestamp: "2026-09-01T10:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "rebuild the pricing table" } }),
      ].join("\n") + "\n",
    );
    writeText(
      path.join(d, "2026-09-02T10-00-00Z_new.jsonl"),
      [
        JSON.stringify({ type: "session", timestamp: "2026-09-02T10:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "The plan has been approved. Implement it now, following each step in order." } }),
      ].join("\n") + "\n",
    );
    const { data } = await readSessionSummaries(d);
    expect(data[0]!.request).toBeNull();
    expect(data.find((s) => s.request)!.request).toBe("rebuild the pricing table");
  });

  it("returns nothing for a directory with no sessions", async () => {
    expect((await readSessionSummaries(tempDir("pcc-none-"))).data).toEqual([]);
  });
});
