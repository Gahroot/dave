import fs from "node:fs/promises";
import type { Stats } from "node:fs";
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

function guard(p: string): string {
  if (isDeniedPath(p)) throw new DeniedPathError(p);
  return p;
}

export const readOnlyFs = {
  async readText(p: string): Promise<string> {
    return fs.readFile(guard(p), "utf8");
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
    const handle = await fs.open(guard(p), "r");
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
      return await fs.stat(guard(p));
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  },

  /** Missing directory returns [] — absent sources are normal, not errors. */
  async readdir(p: string): Promise<string[]> {
    try {
      return await fs.readdir(guard(p));
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
