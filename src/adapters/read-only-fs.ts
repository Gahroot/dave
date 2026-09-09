import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { isDeniedPath } from "../shared/paths.ts";

/**
 * The single chokepoint for reading anything outside PCC_HOME. Exposes read,
 * stat and readdir only — there is deliberately no write/unlink/mkdir here, so
 * "read-only" is a property of the module surface, not of reviewer discipline.
 * Deny-listed files (secrets) throw before any handle is opened.
 */
export class DeniedPathError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`refused to read deny-listed path: ${path}`);
    this.name = "DeniedPathError";
    this.path = path;
  }
}

async function guard(p: string): Promise<string> {
  if (isDeniedPath(p)) throw new DeniedPathError(p);
  const resolved = await fs.realpath(p);
  if (isDeniedPath(resolved)) throw new DeniedPathError(resolved);
  return resolved;
}

export const readOnlyFs = {
  /** Strict collector boundary: no symlink components, regular files only,
   * bounded handle reads. Callers must apply their category/path allowlist first. */
  async containedFile(root: string, relative: string, maxBytes: number, namesOnly = false): Promise<string | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) return null;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return null;
    if (["tasks.json", "projects.json"].includes(path.basename(relative).toLowerCase())) return null;
    try {
      const base = await guard(root);
      let full = base;
      for (const part of relative.split("/")) {
        full = path.join(full, part);
        if (isDeniedPath(full)) return null;
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) return null;
      }
      const canonical = await guard(full);
      if (canonical !== full || !canonical.startsWith(base + path.sep)) return null;
      const stat = await fs.stat(canonical);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      if (namesOnly) return relative;
      const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size > maxBytes) return null;
        if (await fs.realpath(full) !== canonical) return null;
        const buffer = Buffer.alloc(maxBytes + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
          if (!bytesRead) break;
          total += bytesRead;
        }
        const after = await handle.stat();
        if (total > maxBytes || total !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) return null;
        return buffer.subarray(0, total).toString("utf8");
      } finally { await handle.close(); }
    } catch { return null; }
  },
  async readText(p: string): Promise<string> {
    return fs.readFile(await guard(p), "utf8");
  },

  /** Reads and parses JSON; missing file returns null, bad JSON throws. */
  async readJson<T>(p: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await this.readText(p);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    return JSON.parse(raw) as T;
  },

  /** Reads at most `bytes` from the start of a file (header lines only). */
  async readHead(p: string, bytes: number): Promise<string> {
    const handle = await fs.open(await guard(p), "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },

  async stat(p: string): Promise<Stats | null> {
    try {
      return await fs.stat(await guard(p));
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  },

  /** Missing directory returns [] — absent sources are normal, not errors. */
  async readdir(p: string): Promise<string[]> {
    try {
      return await fs.readdir(await guard(p));
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
  },
};

export function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
