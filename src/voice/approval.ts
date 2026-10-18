/**
 * Does the user's own utterance grant "Approve all for this session"? Pure and deterministic.
 * Only the user's own words (spoken transcript or typed text) are ever passed in; never documents, meeting items or
 * tool results. Questions and negations never grant.
 */

const GRANTS: readonly RegExp[] = [
  /\byou(?: have| got| ve got|ve got) my (?:full |complete )?(?:approval|permission|go ahead|blessing|consent)\b/,
  /\b(?:i )?approve (?:all|everything|these|them all|all of (?:them|these|it)|all changes|every change)\b/,
  // "check" only counts when it's about DAVE checking with the user ("don't check with the client" is not a grant).
  /\b(?:dont|do not|no need to|you dont need to|you do not need to|stop) (?:ask|asking|confirm|confirming|(?:check|checking) (?:with |in with )?me)\b/,
  /\bwithout (?:asking|confirming|checking (?:with |in with )?me)\b/,
  /\bjust do it\b/,
  /\byes to (?:all|everything)\b/,
  /\bauto ?approve\b/,
  /\bapprove all\b/,
];

const NEGATIONS: readonly RegExp[] = [
  /\bnot (?:yet )?(?:approved|approve|allowed|permitted)\b/,
  /\b(?:dont|do not|never|cannot|cant|wont|will not) (?:approve|give|grant|have)\b/,
  /\bno (?:approval|permission)\b/,
  /\bwithout (?:my )?(?:approval|permission)\b/,
  /\b(?:waiting|wait) (?:for|on) (?:the )?(?:approval|permission|go ahead)\b/,
  /\b(?:client|they|he|she|someone|anyone) (?:approve|approved|has approved|have approved)\b/,
  /\bask me again\b/,
  /\brevoke\b/,
];

// "do" opens a question only before a subject ("do you…", "do I…"); "do it without asking" is an instruction.
const QUESTION_START = /^(?:did|do(?= (?:i|you|we|they|he|she|the|my|our|your)\b)|does|is|are|was|were|can|could|should|would|will|have|has|who|what|why|how|when|where|which)\b/;

export function normaliseWords(words: string): string {
  return words
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`']/g, "")
    .replace(/[\u201c\u201d"]/g, " ")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9?\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function grantsApproval(words: string | undefined): boolean {
  if (typeof words !== "string") return false;
  const raw = words.trim();
  if (!raw || raw.length > 2_000) return false;
  const norm = normaliseWords(raw);
  if (!norm) return false;
  if (raw.includes("?") || QUESTION_START.test(norm)) return false;
  const text = norm;
  if (NEGATIONS.some((r) => r.test(text))) return false;
  return GRANTS.some((r) => r.test(text));
}
