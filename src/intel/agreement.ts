/**
 * Pulls deliverables and acceptance lines out of pasted agreement text, locally. Zero imports on purpose: the browser
 * bundle runs this, so the pasted text never leaves the page. Pure and deterministic; a person ticks and confirms
 * every candidate before anything is saved.
 */
export type AgreementItem = { title: string; detail: string | null; section: string | null };
export type ParsedAgreement = { items: AgreementItem[]; acceptance: string[] };

export const AGREEMENT_MAX_CHARS = 100_000;
const MAX_TITLE = 300;
const MAX_DETAIL = 2000;
const MAX_ACCEPTANCE = 20;

const CAPTURE = /(deliverable|scope|feature|requirement|milestone|phase|functional|includes|we will)/i;
const STOP = /(out of scope|exclu|not included|assumption|payment|fee|invoice|term|warrant|liabil|confidential|terminat)/i;
const ACCEPT = /(acceptance|done when|success criteria)/i;

type Mode = "capture" | "stop" | "acceptance" | "other";
const BULLET = /^([ \t]*)(?:[-*•·–]|\d+[.)]|\(\w{1,3}\))\s+(.+)$/;
const NUMBERED_HEADING = /^\d+(?:\.\d+)*[.)]?\s+(.{1,60})$/;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const stripMarkup = (s: string): string => squash(s.replace(/^\[[ xX]\]\s*/, "").replace(/\*\*|__|`/g, ""));
const tidy = (s: string): string => stripMarkup(s).replace(/[\s;.,]+$/, "");
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const key = (s: string): string => squash(s.toLowerCase());
const indentOf = (s: string): number => s.replace(/\t/g, "    ").length;

function modeOf(heading: string): Mode {
  if (STOP.test(heading)) return "stop";
  if (ACCEPT.test(heading)) return "acceptance";
  if (CAPTURE.test(heading)) return "capture";
  return "other";
}

type Heading = { text: string; level: number };

/**
 * A heading's text and depth (1 = top), or null when the line is body text or a list item. Depth lets an unnamed
 * sub-heading ("The supplier will build:") stay inside the section above it instead of closing it.
 */
function headingOf(raw: string): Heading | null {
  const line = raw.trim();
  if (!line || line.length > 80) return null;
  const md = /^(#{1,6})\s+(.+)$/.exec(line);
  if (md?.[1] && md[2]) return { text: tidy(md[2].replace(/:$/, "")), level: md[1].length };
  const bold = /^\*\*(.+?)\*\*:?$/.exec(line);
  if (bold?.[1]) return { text: tidy(bold[1]), level: 4 };
  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered?.[1]) {
    // "3. Payment Terms" is a heading; "3. Payment integration with Stripe" is a deliverable. Headings are short, have no
    // inner colon, and are ALL CAPS, end with ":", or are a title-cased section name.
    const endsWithColon = numbered[1].endsWith(":");
    const text = numbered[1].replace(/:$/, "");
    const words = text.split(/\s+/);
    const titleCase = words.every((w) => w.length < 4 || /^[A-Z]/.test(w));
    const allCaps = /[A-Za-z]{2}/.test(text) && text === text.toUpperCase();
    const named = STOP.test(text) || ACCEPT.test(text) || CAPTURE.test(text);
    const looksLikeHeading = words.length <= 5 && !/[.;:]/.test(text) && (allCaps || endsWithColon || (named && titleCase));
    // "1." is depth 1, "1.2" depth 2.
    return looksLikeHeading ? { text: tidy(text), level: (/^\d+((?:\.\d+)*)/.exec(line)?.[1] ?? "").split(".").length } : null;
  }
  if (BULLET.test(raw)) return null;
  if (/[A-Za-z]{2}/.test(line) && line === line.toUpperCase()) return { text: tidy(line.replace(/:$/, "")), level: 1 };
  if (line.endsWith(":") && line.split(/\s+/).length <= 8) return { text: tidy(line.slice(0, -1)), level: 5 };
  return null;
}

export function parseAgreement(text: string, max = 40): ParsedAgreement {
  const lines = text.slice(0, AGREEMENT_MAX_CHARS).split(/\r?\n/);
  const captured: AgreementItem[] = [];
  const fallback: AgreementItem[] = [];
  const acceptance: string[] = [];
  let mode: Mode = "other";
  let modeLevel = 0;
  let section: string | null = null;
  let sawCapture = false;
  let baseIndent: number | null = null;
  let last: { item: AgreementItem; details: string[] } | null = null;
  const lastDetails: { item: AgreementItem; details: string[] }[] = [];

  for (const raw of lines) {
    const heading = headingOf(raw);
    if (heading !== null) {
      const next = modeOf(heading.text);
      // An unnamed deeper heading keeps the section it sits in; anything named, or at the same depth, replaces it.
      if (!(next === "other" && mode !== "other" && heading.level > modeLevel)) { mode = next; modeLevel = heading.level; section = heading.text || null; }
      if (mode === "capture") sawCapture = true;
      baseIndent = null;
      last = null;
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (!bullet) continue;
    const indent = indentOf(bullet[1] ?? "");
    const body = tidy(bullet[2] ?? "");
    if (!body) continue;
    if (baseIndent === null || indent < baseIndent) baseIndent = indent;
    const isSub = indent > baseIndent;
    if (mode === "stop") continue;
    if (mode === "acceptance") { acceptance.push(cap(body, 500)); continue; }
    if (isSub) {
      if (last) last.details.push(body);
      continue;
    }
    const item: AgreementItem = { title: cap(body, MAX_TITLE), detail: null, section };
    last = { item, details: [] };
    lastDetails.push(last);
    (mode === "capture" ? captured : fallback).push(item);
  }

  for (const { item, details } of lastDetails) if (details.length) item.detail = cap(details.join("; "), MAX_DETAIL);

  const seen = new Set<string>();
  const items = (sawCapture ? captured : fallback).filter((i) => {
    const k = key(i.title);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, Math.max(0, max));
  const seenAcceptance = new Set<string>();
  const accepted = acceptance.filter((a) => {
    const k = key(a);
    if (seenAcceptance.has(k)) return false;
    seenAcceptance.add(k);
    return true;
  }).slice(0, MAX_ACCEPTANCE);
  return { items, acceptance: accepted };
}
