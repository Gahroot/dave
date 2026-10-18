import type { FocusState } from "../../intel/types.ts";
import { LIMITS, type ActionCard, type ConfirmCard, type DocumentMeta, type PageContext, type ToolCallResponse, type TranscriptLine, type TranscriptRole, type UiDirective, type VoiceMode } from "../../voice/types.ts";
import { parseRoute } from "../navigation.ts";

export type CopyDirective = NonNullable<UiDirective["copy"]>;
export type UndoState = { batchId: string; state: "ready" | "busy" | "done" | "failed" };
export type VoiceCard =
  | { kind: "action"; id: string; card: ActionCard; undo?: UndoState }
  | { kind: "approval"; id: string; state: "open" | "busy" | "on" | "failed" }
  | { kind: "confirm"; id: string; confirm: ConfirmCard; state: "open" | "busy" | "accepted" | "declined" | "failed" }
  | { kind: "copy"; id: string; copy: CopyDirective; state: "ready" | "copied" | "failed" }
  | { kind: "document"; id: string; document: DocumentMeta; imageSent: boolean };

export type TimelineEntry = { kind: "line"; id: string; line: TranscriptLine } | { kind: "card"; id: string; card: VoiceCard };

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Appends a transcript line, capping characters per line and total entries (oldest drop first). */
export function appendLine(entries: readonly TimelineEntry[], role: TranscriptRole, text: string, at: string, id: string): TimelineEntry[] {
  const clean = text.trim();
  if (!clean) return [...entries];
  const last = entries.at(-1);
  // A repeated identical final line (e.g. delivered twice) is merged.
  if (last?.kind === "line" && last.line.role === role && last.line.text === clip(clean, LIMITS.transcriptLineChars)) return [...entries];
  return capEntries([...entries, { kind: "line", id, line: { role, text: clip(clean, LIMITS.transcriptLineChars), at } }]);
}

export function appendCard(entries: readonly TimelineEntry[], card: VoiceCard): TimelineEntry[] {
  return capEntries([...entries, { kind: "card", id: card.id, card }]);
}

export function updateCard(entries: readonly TimelineEntry[], id: string, patch: (card: VoiceCard) => VoiceCard): TimelineEntry[] {
  return entries.map(e => e.kind === "card" && e.card.id === id ? { ...e, card: patch(e.card) } : e);
}

export function capEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.length > LIMITS.transcriptLines ? entries.slice(entries.length - LIMITS.transcriptLines) : entries;
}

/** Transcript lines to post at the end: the newest lines whose JSON fits LIMITS.transcriptBodyBytes, oldest first. */
export function transcriptOf(entries: readonly TimelineEntry[]): TranscriptLine[] {
  const lines = entries.flatMap(e => e.kind === "line" ? [e.line] : []);
  const encoder = new TextEncoder();
  const kept: TranscriptLine[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const size = encoder.encode(JSON.stringify(line)).length + 1;
    if (bytes + size > LIMITS.transcriptBodyBytes) break;
    bytes += size;
    kept.push(line);
  }
  return kept.reverse();
}

/** Cards a tool response asks the UI to show, in display order. */
export function cardsFromToolResponse(callId: string, response: ToolCallResponse): VoiceCard[] {
  const cards: VoiceCard[] = [];
  // A confirm card already shows the action's title and wording; the matching action card would repeat it.
  if (response.card && !response.confirm) cards.push({ kind: "action", id: `${callId}:card`, card: response.card, ...(response.ui?.undo ? { undo: undoState(response.ui.undo.batchId) } : {}) });
  if (response.confirm) cards.push({ kind: "confirm", id: `${callId}:confirm:${response.confirm.token}`, confirm: response.confirm, state: "open" });
  if (response.ui?.copy) cards.push({ kind: "copy", id: `${callId}:copy`, copy: response.ui.copy, state: "ready" });
  if (response.ui?.offerApproval) cards.push(offerApprovalCard(callId));
  return cards;
}

export const undoState = (batchId: string): UndoState => ({ batchId, state: "ready" });

/** The "Approve all for this session" card shown when approve_session was refused without the user's own words. */
export function offerApprovalCard(callId: string): VoiceCard {
  return { kind: "approval", id: `${callId}:approval`, state: "open" };
}

/** Told to the model when the user turns Approve all on or off on screen. */
export function approvalNote(on: boolean): string {
  return on
    ? "[Update] The user turned on Approve all for this session. Write tools now apply immediately; do not ask before changes."
    : "[Update] The user turned off Approve all. Ask before every change again: prepare, read the say line once, ask Okay?.";
}

/** Open confirm cards, oldest first: the order they are accepted when the user turns Approve all on. */
export function openConfirmIds(entries: readonly TimelineEntry[]): string[] {
  return entries.flatMap(e => e.kind === "card" && e.card.kind === "confirm" && e.card.state === "open" ? [e.card.id] : []);
}

export const UNDO_NOTE = "[Update] The user undid the clean-up.";
export const USER_WORDS_WAIT_MS = 2_000;

/** Approve all banner and live-region text. */
export function approvalAnnouncement(on: boolean): string {
  return on ? "Approve all is on: DAVE makes changes without asking until this conversation ends" : "Approve all is off. DAVE asks before every change.";
}

const quote = (text: string) => `"${text.replace(/["\n\r]+/g, " ").trim()}"`;

export function sharedNote(document: DocumentMeta, imageSent: boolean): string {
  const parts = [document.kind, document.pages ? `${document.pages} page${document.pages === 1 ? "" : "s"}` : null, `text ${document.textState}`].filter(Boolean).join(", ");
  const project = document.projectName ? ` It is attached to ${quote(document.projectName)}.` : "";
  const image = imageSent ? " The image itself was also sent to you." : "";
  return `[Shared] The user shared ${quote(document.name)} (${parts}). Document id: ${document.id}.${project}${image} Acknowledge it briefly and offer to read it.`;
}

/** Sent once a shared document's background text extraction settles; null while it is still pending. */
export function documentTextNote(document: DocumentMeta): string | null {
  if (document.textState === "pending") return null;
  if (document.textState === "ready") return `[Update] The text of ${quote(document.name)} is ready (document id ${document.id}). read_document can open it now.`;
  return `[Update] DAVE could not read text from ${quote(document.name)}. Only what the user says about it is known.`;
}

export function contextNote(context: PageContext, projectName: string | null): string {
  const project = context.projectId ? ` Project: ${projectName ? quote(projectName) : context.projectId} (id ${context.projectId}).` : " No project is selected.";
  return `[Context] The user is now looking at the ${context.route} page.${project} Do not reply to this note.`;
}

export function pageContext(hash: string): PageContext {
  const route = parseRoute(hash);
  return { route: route.destination, projectId: route.project ?? (route.destination === "projects" ? route.id : null) };
}

/** Compares two focus snapshots and describes what is new, or null when nothing worth saying changed. */
export function focusUpdateNote(previous: FocusState | null, next: FocusState): string | null {
  if (!previous) return null;
  const parts: string[] = [];
  if (next.top && next.top.id !== previous.top?.id) parts.push(`New top objective: ${quote(next.top.objective)} for ${quote(next.top.projectName)}.`);
  const known = new Set(previous.decisions.map(d => d.id));
  const fresh = next.decisions.filter(d => !known.has(d.id));
  if (fresh.length) parts.push(`${fresh.length} new decision${fresh.length === 1 ? "" : "s"} waiting: ${fresh.slice(0, 3).map(d => `${quote(d.summary)} (${d.projectName})`).join("; ")}.`);
  return parts.length ? `[Update] ${parts.join(" ")} Mention it at a natural pause.` : null;
}

export function confirmNote(confirm: ConfirmCard, accepted: boolean, ok: boolean): string {
  if (!accepted) return `[Update] The user clicked "Not that" on ${quote(confirm.title)}. Nothing was changed. Ask what they want instead.`;
  return ok ? `[Update] The user confirmed ${quote(confirm.title)} on screen and it is done. Do not ask again.` : `[Update] The user confirmed ${quote(confirm.title)} on screen, but it failed. Nothing was changed.`;
}

export type FocusChips = { decisions: number; noFinishLine: number };
export function focusChips(focus: FocusState | null): FocusChips {
  if (!focus) return { decisions: 0, noFinishLine: 0 };
  return { decisions: focus.decisions.length, noFinishLine: focus.projects.filter(p => !p.outcome).length };
}

export const IMAGE_MAX_SIDE = 1024;
export const IMAGE_QUALITY = 0.8;
export type DownscalePlan = { width: number; height: number; type: "image/jpeg"; quality: number };
export function downscalePlan(width: number, height: number): DownscalePlan | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), type: "image/jpeg", quality: IMAGE_QUALITY };
}
export const imageSendable = (dataUrl: string): boolean => dataUrl.startsWith("data:image/") && dataUrl.length <= LIMITS.imageDataUrlChars;

export type ShortcutKey = { key: string; code: string; altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; repeat?: boolean };
export type ShortcutContext = { panelFocused: boolean; mode: VoiceMode; typing: boolean };
export type Shortcut = "toggle" | "push_to_talk" | null;

export function matchShortcut(event: ShortcutKey, context: ShortcutContext): Shortcut {
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.code === "KeyD" || event.key.toLowerCase() === "d")) return "toggle";
  if ((event.code === "Space" || event.key === " ") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
    context.panelFocused && context.mode === "push_to_talk" && !context.typing) return "push_to_talk";
  return null;
}

/** True for inputs, textareas, selects and contenteditable regions, where Space must type. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}
