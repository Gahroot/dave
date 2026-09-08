import path from "node:path";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import { isDeniedPath } from "../shared/paths.ts";
import { issue, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { EvidenceRef } from "../shared/types.ts";

/** Documentation worth reading, matched case-insensitively on the basename. */
const DOC_PATTERNS = [
  /^readme(\.[a-z]+)?$/i,
  /^agents\.md$/i,
  /^claude\.md$/i,
  /^contributing\.md$/i,
  /^plan\.md$/i,
  /^roadmap\.md$/i,
  /^todo\.md$/i,
  /^tasks\.md$/i,
  /^milestones?\.md$/i,
  /^scope\.md$/i,
  /^brief\.md$/i,
  /^spec\.md$/i,
  /^status\.md$/i,
  /^changelog\.md$/i,
];

const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "composer.json",
]);

/** Never descend into these: dependencies, build output, caches, VCS internals. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".gradle",
  "Pods",
  ".terraform",
  "tmp",
  ".DS_Store",
]);

/** Documentation subdirectories worth one level of descent. */
const DOC_DIRS = new Set(["docs", "doc", ".ezcoder", ".claude"]);

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 24;
const MAX_EXCERPT = 4_000;

export type ScannedFile = {
  path: string;
  /** Truncated file body used for extraction. */
  text: string;
};

export type ProjectEvidence = {
  files: ScannedFile[];
  refs: EvidenceRef[];
};

function isDoc(name: string): boolean {
  return DOC_PATTERNS.some((p) => p.test(name));
}

/**
 * One-time read-only sweep of a project's own documentation and manifest.
 * Dependency trees, build output, secrets, env files and anything oversized are
 * never opened — the size check happens on the stat, before any read.
 */
export async function scanProjectEvidence(
  projectPath: string,
  observedAt: string,
): Promise<Result<ProjectEvidence>> {
  const files: ScannedFile[] = [];
  const refs: EvidenceRef[] = [];
  const issues = [];

  const consider = async (full: string, kind: "file" | "package") => {
    if (files.length >= MAX_FILES) return;
    if (isDeniedPath(full)) return;
    const stat = await readOnlyFs.stat(full);
    if (!stat?.isFile() || stat.size === 0) return;
    if (stat.size > MAX_FILE_BYTES) {
      refs.push({
        kind,
        path: full,
        detail: `skipped: ${Math.round(stat.size / 1024)} KB exceeds the read limit`,
        observedAt,
      });
      return;
    }
    try {
      const text = (await readOnlyFs.readText(full)).slice(0, MAX_EXCERPT);
      files.push({ path: full, text });
      refs.push({
        kind,
        path: full,
        detail: firstMeaningfulLine(text),
        observedAt,
      });
    } catch (e) {
      issues.push(issue("evidence-scan", String(e), full));
    }
  };

  const walk = async (dir: string, depth: number) => {
    for (const name of await readOnlyFs.readdir(dir)) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, name);
      // Skip deny-listed entries before touching them: the read guard throws, and
      // a throw here would abandon the rest of the directory.
      if (isDeniedPath(full)) continue;
      if (SKIP_DIRS.has(name)) continue;
      const stat = await readOnlyFs.stat(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth === 0 && DOC_DIRS.has(name)) await walk(full, depth + 1);
        continue;
      }
      if (isDoc(name)) await consider(full, "file");
      else if (depth === 0 && MANIFESTS.has(name.toLowerCase())) await consider(full, "package");
    }
  };

  try {
    await walk(projectPath, 0);
  } catch (e) {
    issues.push(issue("evidence-scan", String(e), projectPath));
  }

  return ok({ files, refs }, issues);
}

/** A short, quotable excerpt — never a whole document. */
export function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (!line) return "(empty)";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export { SKIP_DIRS, MAX_FILE_BYTES, MAX_FILES };
