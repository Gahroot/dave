/**
 * Talk to DAVE on the phone: pure helpers (no React Native imports) shared by the
 * provider, the dock and the /voice screen, and tested from the repo root
 * (test/mobile-voice.test.ts).
 *
 * The voice server only understands the web's hash routes (#focus?project=…),
 * so the phone translates its own expo-router paths both ways.
 */
import { pageContext } from "../../../../src/ui/voice/model.ts";
import { parseRoute } from "../../../../src/ui/navigation.ts";
import type { DocumentMeta, PageContext, VoiceHistoryEntry } from "../../../../src/voice/types.ts";

export type RouteParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const IDENTIFIER = /^[a-zA-Z0-9_-]{1,200}$/;
const RECORDING = /^\d{1,20}$/;
const RUN_ID = /^[a-f0-9-]{36}$/;
const SECTIONS = ["promises", "asks", "list", "instructions"] as const;
const BUCKETS = ["overdue_promises", "stale_promises", "looks_done", "old_asks", "meeting_decisions"] as const;
const DESTINATIONS = new Set(["focus", "queue", "projects", "agents", "meetings", "cleanup", "connections", "issues", "voice"]);

const first = (value: string | readonly string[] | undefined): string | null => {
  const v = typeof value === "string" ? value : value?.[0];
  return v === undefined || v === "" ? null : v;
};
const id = (value: string | null | undefined): string | null => value && IDENTIFIER.test(value) ? value : null;
const query = (values: Record<string, string | null>): string => {
  const parts = Object.entries(values).flatMap(([k, v]) => v === null ? [] : [`${k}=${encodeURIComponent(v)}`]);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * The web hash route for a phone screen, e.g. "/project/p1" → "#projects?id=p1".
 * Screens with no web counterpart (More, Phone connection, pairing) count as Focus.
 */
export function phonePathToWebRoute(pathname: string, params: RouteParams = {}): string {
  const segments = pathname.split("?")[0]?.split("/").filter((s) => s !== "" && !s.startsWith("(")) ?? [];
  const [head = "", second, third] = segments;
  if (third !== undefined) return "#focus";
  switch (head) {
    case "": return "#focus";
    case "focus": return `#focus${query({ project: id(second) })}`;
    case "queue": return second === undefined ? "#queue" : "#focus";
    case "projects": return "#projects";
    case "project": return `#projects${query({ id: id(second) })}`;
    case "delivery": { const p = id(second); return p ? `#projects${query({ id: p, tab: "delivery" })}` : "#projects"; }
    case "meetings": {
      if (second === "instructions") return "#meetings?section=instructions";
      if (second !== undefined) return RECORDING.test(second) ? `#meetings?rec=${second}` : "#meetings";
      const section = first(params.section);
      return SECTIONS.find((s) => s === section && s !== "promises") ? `#meetings?section=${section}` : "#meetings";
    }
    case "agents": {
      if (second === undefined) return "#agents";
      if (second === "new") return `#agents${query({ view: "new", project: id(first(params.project)) })}`;
      if (second === "settings") return "#agents?view=settings";
      return RUN_ID.test(second) ? `#agents/${second}` : "#agents";
    }
    case "cleanup": { const bucket = first(params.bucket); return `#cleanup${query({ bucket: BUCKETS.find((b) => b === bucket) ?? null })}`; }
    case "connections": case "issues": case "voice": return second === undefined ? `#${head}` : "#focus";
    default: return "#focus";
  }
}

/** Where the user is, as voice start and context notes describe it. */
export function phonePageContext(pathname: string, params: RouteParams = {}): PageContext {
  return pageContext(phonePathToWebRoute(pathname, params));
}

/** The phone screen for a UI `navigate` directive (a web hash route); null for anything unknown. */
export function webRouteToPhoneHref(hash: string): string | null {
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length > 2000) return null;
  const base = hash.slice(1).split(/[?/]/)[0] ?? "";
  if (!DESTINATIONS.has(base)) return null;
  const route = parseRoute(hash);
  switch (route.destination) {
    case "focus": return route.project ? `/focus/${route.project}` : "/(tabs)";
    case "queue": return "/(tabs)/queue";
    case "projects": return route.id ? `/project/${route.id}` : "/(tabs)/projects";
    case "meetings":
      if (route.rec) return `/meetings/${route.rec}`;
      return route.section === "promises" ? "/(tabs)/meetings" : `/(tabs)/meetings?section=${route.section}`;
    case "agents":
      if (route.runId) return `/agents/${route.runId}`;
      if (route.view === "new") return `/agents/new${query({ project: route.project, handoff: route.handoff, meetingItem: route.meetingItem })}`;
      if (route.view === "settings") return "/agents/settings";
      return "/agents";
    case "cleanup": return route.bucket ? `/cleanup?bucket=${route.bucket}` : "/cleanup";
    case "connections": return "/connections";
    case "issues": return "/issues";
    case "voice": return "/voice";
  }
}

/** Screens that show the tab bar (the dock floats above it). */
export function isTabPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/queue" || pathname === "/projects" || pathname === "/meetings" || pathname === "/more";
}

/** The dock hides where it would cover the voice page itself or pairing. */
export function dockHidden(pathname: string): boolean {
  return pathname === "/voice" || pathname.startsWith("/voice/") || pathname === "/pair" || pathname.startsWith("/pair/");
}

// ── Bytes ────────────────────────────────────────────────────────────────────

/** base64url (the gateway's binary encoding) → standard padded base64. */
export function base64UrlToBase64(text: string): string {
  const b = text.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += (B64[(n >> 18) & 63] ?? "") + (B64[(n >> 12) & 63] ?? "") + (b === undefined ? "=" : B64[(n >> 6) & 63] ?? "") + (c === undefined ? "=" : B64[n & 63] ?? "");
  }
  return out;
}

/** A data URI for an image answer from `api.binary`, or null for anything that is not an image. */
export function imageDataUri(body: { base64url: string; contentType: string }): string | null {
  const type = body.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^image\/(png|jpeg|jpg|gif|webp|heic|heif)$/.test(type)) return null;
  return `data:${type};base64,${base64UrlToBase64(body.base64url)}`;
}

/** MIME type for a picked file (pickers do not always report one). */
export function mimeOf(name: string, reported?: string | null): string {
  if (reported) return reported.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

/** Image types the model can take directly as a data URL. */
export const isModelImageType = (mime: string): boolean => mime === "image/jpeg" || mime === "image/png";

// ── Levels ───────────────────────────────────────────────────────────────────

export type AudioLevels = { input: number; output: number };
type StatsRecord = { type?: unknown; kind?: unknown; mediaType?: unknown; audioLevel?: unknown; remoteSource?: unknown };
const level = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;

/**
 * Mic and DAVE levels (0..1) from one `RTCPeerConnection.getStats()` report:
 * `media-source` (or a local `track`) audioLevel is the mic, `inbound-rtp`
 * (or a remote `track`) audioLevel is DAVE's voice.
 */
export function levelsFromStats(reports: Iterable<unknown>): AudioLevels {
  let input: number | null = null, output: number | null = null;
  for (const raw of reports) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as StatsRecord;
    const audio = r.kind === "audio" || r.mediaType === "audio";
    if (!audio) continue;
    const value = level(r.audioLevel);
    if (value === null) continue;
    if (r.type === "media-source") input = Math.max(input ?? 0, value);
    else if (r.type === "inbound-rtp") output = Math.max(output ?? 0, value);
    else if (r.type === "track") {
      if (r.remoteSource === true) output ??= value; else input ??= value;
    }
  }
  return { input: input ?? 0, output: output ?? 0 };
}

// ── Display text ─────────────────────────────────────────────────────────────

/** The document card's one-line summary (same parts and order as the web). */
export function documentSummary(doc: DocumentMeta, imageSent: boolean): string {
  return [doc.kind.toUpperCase(), doc.pages ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}` : null,
    doc.textState === "ready" ? "text read" : doc.textState === "pending" ? "reading text…" : "no text", imageSent ? "image sent" : null]
    .filter((p): p is string => p !== null).join(" · ");
}

export function historySummary(entry: VoiceHistoryEntry): string {
  return entry.summary ?? `${entry.lines} lines, ${entry.actions} actions`;
}

export function chipLabels(chips: { decisions: number; noFinishLine: number }, lookingAt: string | null): { text: string; tone: "amber" | "gray" | "violet" }[] {
  const out: { text: string; tone: "amber" | "gray" | "violet" }[] = [];
  if (chips.decisions > 0) out.push({ text: `${chips.decisions} decision${chips.decisions === 1 ? "" : "s"} waiting`, tone: "amber" });
  if (chips.noFinishLine > 0) out.push({ text: `${chips.noFinishLine} without a finish line`, tone: "gray" });
  if (lookingAt) out.push({ text: `Looking at: ${lookingAt}`, tone: "violet" });
  return out;
}

/** Same wording as the web transport. */
export const MIC_DENIED_MESSAGE = "DAVE cannot hear you: allow microphone access for this page, then try again.";
export const UNSUPPORTED_MESSAGE = "This phone cannot do voice (no microphone or WebRTC support).";
export const NOT_AVAILABLE_MESSAGE = "Voice is not available on this server yet.";
/** Reasons whose fix is in Connections (same set as the web). */
export const CONNECT_REASONS: readonly string[] = ["not_connected", "reconnect", "not_entitled"];
export const VOICE_UNAVAILABLE_REASONS: readonly string[] = ["disabled", "not_connected", "reconnect", "not_entitled", "rate_limited", "mint_failed"];

/** The `reason` of a 503 voice error body, if it is one the server sends. */
export function unavailableReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === "string" && VOICE_UNAVAILABLE_REASONS.includes(reason) ? reason : null;
}
