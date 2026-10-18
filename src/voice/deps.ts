/** Structural dependencies of the voice backend, so tests can inject fakes and the server wires real services. */
import type { IntelService } from "../intel/service.ts";
import type { DirectionApi } from "../intel/types.ts";
import type { MeetingItem, ItemKind as MeetingItemKind, ItemStatus as MeetingItemStatus } from "../meetings/types.ts";
import type { AttentionAction, Portfolio } from "../shared/types.ts";
import type { TriageService } from "../triage/service.ts";

export type VoiceIntel = Pick<IntelService,
  "focus" | "projectIntel" | "putOutcome" | "addItem" | "patchItem" | "resolveProposal" | "setSchedule" | "setStep" | "markDemo" |
  "verifyItem" | "reopenItem" | "addFinishLineItems" | "reconcile" | "knownProject" | "sourceHealth"> & DirectionApi;

export type VoiceMeetings = {
  items(filter: { kinds: MeetingItemKind[]; statuses: MeetingItemStatus[] }): MeetingItem[];
  setItemStatus(id: string, action: unknown): MeetingItem;
  /** Promise (firm) or just an idea (tentative); the user's choice survives re-analysis. */
  setItemStrength(id: string, strength: "firm" | "tentative"): MeetingItem;
  /** The latest analysed meetings, newest first, for scoping a clean-up by meeting title. */
  recentMeetings(limit: number): { recordingId: string; title: string; at: string | null }[];
  syncNow(): unknown;
  /** Storage-free: Fathom was connected (settings), not a Keychain read. */
  fathomConnected(): boolean;
};

export type VoicePortfolio = {
  refresh(): Promise<Portfolio>;
  current(): Promise<Portfolio>;
  attention(id: string, action: AttentionAction): Portfolio | null;
  override(id: string, next: { pinned?: boolean }): boolean;
};

/** Projects the user can talk about (visible portfolio projects plus any with intelligence). */
export type ProjectList = () => { id: string; name: string }[];

/** Clean up (bulk clear / mark done with undo), for find_noise, clean_up and undo_clean_up. */
export type VoiceTriage = Pick<TriageService, "preview" | "apply" | "undo" | "batches">;
