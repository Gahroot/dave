import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * Project identity key. Resolves `~`, `..`, symlinks and trailing separators so
 * that two sources naming the same directory differently still dedupe.
 * Non-existent paths are still canonicalized (lexically) so we can report them
 * as "unavailable" rather than dropping them.
 */
export function canonicalPath(input: string): string {
  const expanded = input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : input;
  let resolved = path.resolve(expanded);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Missing path: keep the lexical resolution.
  }
  const stripped =
    resolved.length > 1 && resolved.endsWith(path.sep)
      ? resolved.slice(0, -1)
      : resolved;
  return CASE_INSENSITIVE ? stripped.toLowerCase() : stripped;
}

export function pathExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
