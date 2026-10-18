import path from "node:path";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import { readEzcoderSessionDirs } from "../adapters/ezcoder-sessions.ts";
import type { SourcePaths } from "../shared/paths.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "./store.ts";
import { cleanText, parseMarkers } from "./text.ts";
import type { WorkOutcome } from "./types.ts";

export const HEAD_BYTES = 16 * 1024;
export const TAIL_BYTES = 64 * 1024;
export const MAX_FILES_PER_POLL = 50;
const MAX_FIRST_MESSAGE = 8 * 1024;
const MAX_SUMMARY = 1000;
const MAX_TITLE = 160;
const CURSOR = "ezcoder";

/** One finished EZ Coder run, before it is mapped to a project. */
export type EzcoderRun = {
  sessionId: string;
  cwd: string;
  generation: number;
  outcome: Extract<WorkOutcome, "completed" | "failed" | "aborted" | "unverified">;
  at: string;
  title: string;
  summary: string | null;
  marker: { objectiveId: string | null; itemIds: string[] };
};

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const OUTCOMES = ["completed", "failed", "aborted", "unverified"] as const;

function textOf(content: unknown): string | null {
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return str(parts.join("\n"));
}

function parseLines(text: string): Rec[] {
  return text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { const r = asRecord(JSON.parse(l)); return r ? [r] : []; } catch { return []; }
  });
}

/** Session id, cwd, first user request and the markers, from at most 16 KB of the head. */
export function parseHead(head: string, complete: boolean): { sessionId: string | null; cwd: string | null; firstUser: string | null } {
  // A cut-off last line is not JSON; drop it unless the whole file fit.
  const lines = complete ? head : head.slice(0, Math.max(0, head.lastIndexOf("\n")));
  let sessionId: string | null = null, cwd: string | null = null, firstUser: string | null = null;
  for (const row of parseLines(lines)) {
    if (row.type === "session") { sessionId ??= str(row.id); cwd ??= str(row.cwd); continue; }
    if (firstUser === null && row.type === "message") {
      const m = asRecord(row.message);
      if (m?.role === "user") firstUser = textOf(m.content)?.slice(0, MAX_FIRST_MESSAGE) ?? null;
    }
  }
  return { sessionId, cwd, firstUser };
}

/** `run_finished` rows from at most 64 KB of the tail, each with the last assistant text before it. */
export function parseTail(tail: string, partialFirst: boolean): { generation: number; outcome: EzcoderRun["outcome"]; at: string | null; lastText: string | null }[] {
  const body = partialFirst ? tail.slice(tail.indexOf("\n") + 1) : tail;
  if (partialFirst && !tail.includes("\n")) return [];
  const out: ReturnType<typeof parseTail> = [];
  let lastText: string | null = null;
  for (const row of parseLines(body)) {
    if (row.type === "message") {
      const m = asRecord(row.message);
      if (m?.role === "assistant") lastText = textOf(m.content) ?? lastText;
      continue;
    }
    if (row.type !== "custom" || row.kind !== "run_finished") continue;
    const data = asRecord(row.data);
    const generation = data?.generation;
    const outcome = OUTCOMES.find((o) => o === data?.outcome);
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0 || !outcome) continue;
    const ts = str(row.timestamp);
    const at = ts && Number.isFinite(Date.parse(ts)) ? new Date(Date.parse(ts)).toISOString() : null;
    out.push({ generation, outcome, at, lastText });
  }
  return out;
}

type SessionFile = { file: string; size: number; mtimeMs: number };

async function listFiles(paths: SourcePaths, signal?: AbortSignal): Promise<SessionFile[]> {
  const dirs = await readEzcoderSessionDirs(paths);
  const out: SessionFile[] = [];
  for (const d of [...dirs.data].sort((a, b) => a.dir.localeCompare(b.dir))) {
    signal?.throwIfAborted();
    for (const name of (await readOnlyFs.readdir(d.dir)).filter((f) => f.endsWith(".jsonl")).sort()) {
      const file = path.join(d.dir, name);
      const st = await readOnlyFs.stat(file).catch(() => null);
      if (st?.isFile()) out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Finished EZ Coder runs in session files whose size or mtime changed since the last poll (newest first, at most 50
 * files per poll). Reads only a bounded head and tail of each file, through readOnlyFs. Text is redacted and clipped.
 * Cursors advance for every file read, so an unchanged file is never read again.
 */
export async function scanEzcoderRuns(db: Db, paths: SourcePaths, at: string, signal?: AbortSignal): Promise<EzcoderRun[]> {
  const files = (await listFiles(paths, signal))
    .filter((f) => getCursor(db, CURSOR, f.file) !== `${f.size}:${f.mtimeMs}`)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
    .slice(0, MAX_FILES_PER_POLL);
  const runs: EzcoderRun[] = [];
  for (const f of files) {
    signal?.throwIfAborted();
    try {
      const head = parseHead(await readOnlyFs.readHead(f.file, HEAD_BYTES), f.size <= HEAD_BYTES);
      const tail = parseTail(await readOnlyFs.readTail(f.file, TAIL_BYTES), f.size > TAIL_BYTES);
      if (head.cwd && head.sessionId) {
        const marker = parseMarkers(head.firstUser ?? "");
        const title = cleanText((head.firstUser ?? "").split("\n").find((l) => l.trim() && !/^DAVE-/.test(l.trim()))?.replace(/^\s*Objective:\s*/, "") ?? "EZ Coder run", MAX_TITLE) || "EZ Coder run";
        const fallbackAt = new Date(f.mtimeMs).toISOString();
        for (const t of tail) {
          runs.push({
            sessionId: head.sessionId, cwd: head.cwd, generation: t.generation, outcome: t.outcome, at: t.at ?? fallbackAt,
            title, summary: t.lastText ? cleanText(t.lastText, MAX_SUMMARY) : null, marker,
          });
        }
      }
    } catch { /* unreadable file: skip it this time and every time until it changes */ }
    setCursor(db, CURSOR, f.file, `${f.size}:${f.mtimeMs}`, at);
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at) || a.sessionId.localeCompare(b.sessionId) || a.generation - b.generation);
}
