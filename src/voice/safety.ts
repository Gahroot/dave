/**
 * Everything DAVE passes to the voice model goes through speakable(); document text read by voice goes through
 * redactSecrets(). Pure and deterministic. Regex screening is defense in depth: it cannot prove arbitrary text
 * carries no private business data, which is why documents are read only when asked.
 */

const REDACTED = "[redacted]";

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // Provider keys and tokens with well-known prefixes.
  /\b(?:sk|rk|pk)-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bek_[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JWTs (three base64url parts, the first starting with a JSON header).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Authorization headers.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Credentials inside URLs.
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];

/** key = value / key: value pairs whose key names a secret. The key is kept so the sentence still reads. */
const SECRET_ASSIGNMENT = /\b((?:password|passwd|pwd|secret|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|private[_ -]?key)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi;

/** Long random-looking runs (mixed letters and digits, 32+ characters) are treated as secrets. */
const LONG_RANDOM = /\b[A-Za-z0-9_-]{32,}\b/g;
const looksRandom = (s: string): boolean => (/[0-9]/.test(s) && /[A-Za-z]/.test(s)) || s.length >= 48;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, scheme?: unknown) => (typeof scheme === "string" && match.startsWith(scheme) && match.endsWith("@") ? `${scheme}${REDACTED}@` : REDACTED));
  }
  out = out.replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}${REDACTED}`);
  out = out.replace(LONG_RANDOM, (m) => (looksRandom(m) ? REDACTED : m));
  return out;
}

const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
const URL_PATTERN = /\b(?:https?|ftp|file|wss?):\/\/[^\s<>"')]+/gi;
const WWW = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"')]*/gi;
// Absolute and home paths (POSIX and Windows), and relative paths with two or more separators.
const PATHS = /(?:~|\B)\/(?:[\w.@-]+\/)+[\w.@-]*|\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*|\b(?:[\w.@-]+\/){2,}[\w.@-]+/g;

/** Text safe to hand to the voice model: no secrets, URLs, file paths or code blocks; one line; at most `max` chars. */
export function speakable(text: string, max = 600): string {
  let out = redactSecrets(String(text));
  out = out.replace(CODE_FENCE, " (code left out) ");
  out = out.replace(URL_PATTERN, "a link").replace(WWW, "a link");
  out = out.replace(PATHS, "a file");
  out = out.replace(/`+/g, "").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(max));
  if (out.length <= limit) return out;
  return `${out.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
