/** Fuzzy matching of spoken names to projects, items, documents. Pure. */
export type Named = { id: string; name: string };
export type Resolution<T> = { project: T } | { ambiguous: true; candidates: string[] } | { none: true };

const norm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (s: string): string[] => norm(s).split(" ").filter((t) => t.length > 1 && !["the", "project", "app", "for"].includes(t));

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function pick<T extends Named>(matches: T[]): Resolution<T> | null {
  if (matches.length === 1 && matches[0]) return { project: matches[0] };
  if (matches.length > 1) return { ambiguous: true, candidates: matches.slice(0, 3).map((m) => m.name) };
  return null;
}

/** id, exact name (case-insensitive), prefix, contains, token overlap, edit distance ≤ 2. */
export function resolveNamed<T extends Named>(query: string, all: readonly T[]): Resolution<T> {
  const q = query.trim();
  if (!q) return { none: true };
  const list = [...all].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const byId = list.find((x) => x.id === q);
  if (byId) return { project: byId };
  const n = norm(q);
  if (!n) return { none: true };
  const steps: ((x: T) => boolean)[] = [
    (x) => norm(x.name) === n,
    (x) => norm(x.name).startsWith(n),
    (x) => norm(x.name).includes(n) || (n.length >= 4 && n.includes(norm(x.name)) && norm(x.name).length >= 3),
  ];
  for (const step of steps) { const r = pick(list.filter(step)); if (r) return r; }
  const qt = tokens(q);
  if (qt.length) {
    const scored = list.map((x) => { const xt = tokens(x.name); return { x, score: qt.filter((t) => xt.includes(t)).length }; }).filter((s) => s.score > 0);
    const best = Math.max(0, ...scored.map((s) => s.score));
    const r = pick(scored.filter((s) => s.score === best).map((s) => s.x));
    if (r) return r;
  }
  const close = list.map((x) => ({ x, d: levenshtein(norm(x.name), n) })).filter((s) => s.d <= 2);
  const minD = Math.min(3, ...close.map((s) => s.d));
  const r = pick(close.filter((s) => s.d === minD).map((s) => s.x));
  return r ?? { none: true };
}

export const resolveProject = resolveNamed;

/** Items by id or title within one project. */
export function resolveItem<T extends { id: string; title: string }>(query: string, items: readonly T[]): Resolution<T> {
  const named = items.map((i) => ({ id: i.id, name: i.title, item: i }));
  const r = resolveNamed(query, named);
  return "project" in r ? { project: r.project.item } : r;
}
