import path from "node:path";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import { canonicalPath } from "../core/canonical-path.ts";

export type WorkProject = { id: string; name: string; path: string };

async function readSmall(p: string): Promise<string | null> {
  try { return await readOnlyFs.readHead(p, 4096); } catch { return null; }
}

/**
 * The main checkout for a working directory, following git's own pointer files: a `.git` directory is a main
 * checkout; a `.git` file names `gitdir: …/worktrees/<name>`, whose `commondir` leads to the main `.git`. Reads only
 * those small pointer files. null when nothing resolves (deleted checkout, submodule, bare repository).
 */
export async function mainCheckout(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st: Awaited<ReturnType<typeof readOnlyFs.stat>> = null;
    try { st = await readOnlyFs.stat(dotGit); } catch { st = null; }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) return fromDotGitFile(dir, dotGit);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function fromDotGitFile(dir: string, dotGit: string): Promise<string | null> {
  const line = (await readSmall(dotGit))?.split(/\r?\n/).find((l) => l.startsWith("gitdir:"));
  const target = line?.slice("gitdir:".length).trim();
  if (!target) return null;
  const gitdir = path.isAbsolute(target) ? target : path.resolve(dir, target);
  // `modules/<name>` is a submodule: its own repository, not a second checkout.
  if (path.basename(path.dirname(gitdir)) !== "worktrees") return null;
  const pointer = (await readSmall(path.join(gitdir, "commondir")))?.trim();
  const common = pointer ? (path.isAbsolute(pointer) ? pointer : path.resolve(gitdir, pointer)) : path.dirname(path.dirname(gitdir));
  const st = await readOnlyFs.stat(common).catch(() => null);
  if (!st?.isDirectory() || path.basename(common) !== ".git") return null;
  const root = path.dirname(common);
  return root === dir ? null : root;
}

/** The project whose path equals or contains `dir` (deepest wins). */
function projectAt(dir: string, projects: WorkProject[]): WorkProject | null {
  const key = canonicalPath(dir);
  const hits = projects
    .map((p) => ({ p, k: canonicalPath(p.path) }))
    .filter(({ k }) => key === k || key.startsWith(k + path.sep))
    .sort((a, b) => b.k.length - a.k.length || a.p.id.localeCompare(b.p.id));
  return hits[0]?.p ?? null;
}

/**
 * Maps an EZ Coder session cwd to a project: directly, through the worktree's main checkout, or, for a deleted
 * worktree under `<home>/.ezcoder/worktrees/<repo>/<name>`, by a project whose folder name is exactly `<repo>` when
 * only one project has that name. Otherwise null and the event is dropped.
 */
export async function projectForCwd(cwd: string, projects: WorkProject[], home: string): Promise<WorkProject | null> {
  const main = await mainCheckout(cwd);
  if (main) {
    const hit = projectAt(main, projects);
    if (hit) return hit;
  }
  const direct = projectAt(cwd, projects);
  if (direct) return direct;
  const root = path.join(home, ".ezcoder", "worktrees");
  const rel = path.relative(root, path.resolve(cwd));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [repo, name] = rel.split(path.sep);
  if (!repo || !name) return null;
  const fold = (s: string): string => (process.platform === "darwin" || process.platform === "win32" ? s.toLowerCase() : s);
  const same = projects.filter((p) => fold(path.basename(canonicalPath(p.path))) === fold(repo));
  return same.length === 1 ? (same[0] ?? null) : null;
}
