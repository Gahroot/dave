import path from "node:path";
import { readOnlyFs } from "./read-only-fs.ts";
import { ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";

/** Read at most this much of a transcript: enough for the opening request. */
const HEAD_BYTES = 16 * 1024;
const MAX_SESSIONS = 5;
const MAX_TEXT = 240;

export type SessionSummary = {
  file: string;
  startedAt: string;
  /** The opening request of the session — what the work was about. */
  request: string | null;
  /** True if the run recorded an explicit failure or error record. */
  failed: boolean;
};

function clean(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/**
 * Harness scaffolding that wraps a real request: automation preambles, restored
 * conversation summaries, and system reminders. None of it describes what the
 * user was working on, so it is stripped before the request is used.
 */
const BOILERPLATE_BLOCK = [
  /^\s*\[Autopilot\][\s\S]*?Your instruction:\s*/i,
  /^\s*\[Previous conversation summary\][\s\S]*?(?=\n\s*(?:#{1,3}\s*)?(?:Next step|Current task|User request)\b)/i,
  /^\s*<(system-reminder|environment_details)>[\s\S]*?<\/\1>\s*/i,
  /^\s*\[Status update on background work[\s\S]*?\]\s*/i,
];

/** Lines that are pure harness chatter even after the blocks are removed. */
const BOILERPLATE_LINE =
  /^\s*(?:-\s*)?(?:Prove your work|Don't stop to ask|Only surface a question|This turn was triggered|Verification gate|Background-process completion gate|\[Autopilot\]|### Next Step|None — awaiting user direction)/i;

/**
 * Requests that say nothing about the project: generic go-aheads, approvals and
 * one-word replies. They are real user messages, so they survive boilerplate
 * stripping, but they cannot describe what was being worked on.
 */
const CONTENTLESS =
  /^(?:the plan (?:has been|is) approved[.!]?(?: implement it now[,.]? ?(?:following each step in order)?[.!]?)?|(?:ok(?:ay)?|yes|yep|sure|go ahead|proceed|continue|do it|approved|lgtm|thanks?|ship it)[.!]*)$/i;

export function isContentlessRequest(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length < 12 || CONTENTLESS.test(t);
}

export function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of BOILERPLATE_BLOCK) out = out.replace(re, "");
  const kept = out
    .split("\n")
    .filter((l) => !BOILERPLATE_LINE.test(l))
    .join("\n");
  return kept.trim() || out.trim();
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : null))
      .filter((v): v is string => !!v);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

/**
 * Extracts what a session was about from its opening records only. Reads a
 * bounded prefix — never a whole transcript — and only from the newest few
 * sessions of a project.
 */
export async function readSessionSummaries(
  sessionDir: string,
  limit = MAX_SESSIONS,
): Promise<Result<SessionSummary[]>> {
  const names = (await readOnlyFs.readdir(sessionDir))
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit);

  const out: SessionSummary[] = [];
  for (const name of names) {
    const file = path.join(sessionDir, name);
    let head: string;
    try {
      head = await readOnlyFs.readHead(file, HEAD_BYTES);
    } catch {
      continue;
    }
    const lines = head.split("\n");
    let startedAt = "";
    let request: string | null = null;
    let failed = false;

    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A truncated final line is expected: we read a fixed prefix.
        break;
      }
      if (rec.type === "session" && typeof rec.timestamp === "string") startedAt = rec.timestamp;
      if (!request && rec.type === "message") {
        const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
        if (msg?.role === "user") {
          const raw = textOf(msg.content);
          const text = raw ? stripBoilerplate(raw) : null;
          // Scaffolding or a bare "go ahead" tells us nothing about the work.
          if (text && !isContentlessRequest(text)) request = clean(text);
        }
      }
      if (rec.kind === "run_failed" || rec.type === "error") failed = true;
      // Keep scanning the bounded prefix: a failure record usually comes after
      // the opening request, so breaking early would miss it.
    }

    // A redirect stub points at a compressed archive; it carries no request.
    out.push({ file, startedAt: startedAt || "", request, failed });
  }
  return ok(out);
}
