import {
  Ban, Bot, CalendarClock, CircleCheck, CircleDashed, CircleDot, CircleHelp, CirclePlay, CircleSlash, CircleStop, CircleX,
  Clock, ClockAlert, CloudOff, Eye, Flag, Gavel, Hand, Handshake, KeyRound, Lightbulb, ListChecks, LoaderCircle,
  MessageCircleQuestion, MessageSquareWarning, PackageCheck, Plug, Send, TriangleAlert, Unplug, UserCheck, type LucideIcon,
} from "lucide-react";
import type { RunStatus } from "../agents/types.ts";
import type { InboxKind } from "../shared/types.ts";
import type { NextStepKind } from "../model/delivery-next-step.ts";
import type { ItemKind, ItemStatus, MeetingStatus, PromiseStateName } from "../meetings/types.ts";
import type { PromiseGroup } from "./meetings-model.ts";

/**
 * The one status language. Tone answers "whose move is it", the icon shape answers
 * "what kind", the label says exactly what. Color is never the only signal.
 *
 * amber  = your move          blue  = working, no decision     green = done or passed
 * red    = broken             gray  = parked, not run, cached  violet = DAVE's guess
 */
export const TONES = ["amber", "blue", "green", "red", "gray", "violet"] as const;
export type Tone = (typeof TONES)[number];
export type StatusSpec = Readonly<{ tone: Tone; icon: LucideIcon; label: string; spin?: boolean }>;

/** Tones that ask for the owner or flag a failure get a row rail; calm states do not. */
export const RAIL_TONES: ReadonlySet<Tone> = new Set(["amber", "red", "violet"]);
export const hasRail = (tone: Tone): boolean => RAIL_TONES.has(tone);

/** Agent runs. Labels stay identical to the words the walkthroughs and help text use. */
export const RUN_STATUS: Readonly<Record<RunStatus, StatusSpec>> = {
  queued: { tone: "gray", icon: Clock, label: "Queued" },
  starting: { tone: "blue", icon: LoaderCircle, label: "Preparing workspace", spin: true },
  running: { tone: "blue", icon: LoaderCircle, label: "Working", spin: true },
  waiting: { tone: "amber", icon: Hand, label: "Needs permission" },
  review: { tone: "amber", icon: Eye, label: "Review or reply" },
  checking: { tone: "blue", icon: LoaderCircle, label: "Running checks", spin: true },
  accepted: { tone: "green", icon: UserCheck, label: "Accepted, not merged" },
  failed: { tone: "red", icon: CircleX, label: "Failed" },
  stopped: { tone: "gray", icon: CircleStop, label: "Stopped" },
  interrupted: { tone: "amber", icon: TriangleAlert, label: "Disconnected" },
};

export type MilestoneStatus = "ready" | "waiting" | "handed-off" | "needs-review" | "accepted" | "contested";
export const MILESTONE_STATUS: Readonly<Record<MilestoneStatus, StatusSpec>> = {
  ready: { tone: "blue", icon: CirclePlay, label: "Ready" },
  waiting: { tone: "gray", icon: Clock, label: "Waiting" },
  "handed-off": { tone: "blue", icon: Send, label: "Sent off" },
  "needs-review": { tone: "amber", icon: Eye, label: "Needs your review" },
  accepted: { tone: "green", icon: UserCheck, label: "Accepted by you" },
  contested: { tone: "amber", icon: Gavel, label: "Sent back, decide" },
};

/** The delivery "what now" step, as shown on Inbox rows and the delivery header. */
export const NEXT_STEP: Readonly<Record<NextStepKind, StatusSpec>> = {
  setup: { tone: "amber", icon: Flag, label: "Set the goal" },
  scope: { tone: "amber", icon: ListChecks, label: "Define finished" },
  plan: { tone: "amber", icon: ListChecks, label: "Plan the pieces" },
  send: { tone: "amber", icon: Send, label: "Ready to send" },
  waiting: { tone: "blue", icon: Clock, label: "With your coding tool" },
  stalled: { tone: "amber", icon: ClockAlert, label: "Gone quiet" },
  review: { tone: "amber", icon: Eye, label: "Needs your review" },
  unblock: { tone: "amber", icon: Hand, label: "Blocked on someone" },
  decide: { tone: "amber", icon: Gavel, label: "Your decision" },
  done: { tone: "green", icon: PackageCheck, label: "Ready for a person" },
};

export type CheckResult = "passed" | "failed" | "interrupted" | "not-run";
export const CHECK_RESULT: Readonly<Record<CheckResult, StatusSpec>> = {
  passed: { tone: "green", icon: CircleCheck, label: "Passed" },
  failed: { tone: "red", icon: CircleX, label: "Failed" },
  interrupted: { tone: "amber", icon: TriangleAlert, label: "Interrupted" },
  "not-run": { tone: "gray", icon: CircleDashed, label: "Not run" },
};
export const checkResult = (exitCode: number | null | undefined, ran = true): CheckResult =>
  !ran ? "not-run" : exitCode === 0 ? "passed" : exitCode === null || exitCode === undefined ? "interrupted" : "failed";

/** Reported criteria come from the agent: never green, because nobody independent checked them. */
export type CriterionResult = "met" | "failed" | "unknown";
export const CRITERION_REPORTED: Readonly<Record<CriterionResult, StatusSpec>> = {
  met: { tone: "gray", icon: Bot, label: "Reported met" },
  failed: { tone: "red", icon: CircleX, label: "Reported failed" },
  unknown: { tone: "gray", icon: CircleHelp, label: "Unknown" },
};

/** Data freshness. Cached is never drawn like checked. */
export type Freshness = "checked" | "cached" | "unavailable";
export const FRESHNESS: Readonly<Record<Freshness, StatusSpec>> = {
  checked: { tone: "green", icon: CircleCheck, label: "Checked" },
  cached: { tone: "gray", icon: CircleDashed, label: "Cached" },
  unavailable: { tone: "red", icon: CloudOff, label: "Unavailable" },
};

export const INBOX_KIND: Readonly<Record<InboxKind, StatusSpec>> = {
  "approval-request": { tone: "amber", icon: Eye, label: "Approval" },
  "failed-run": { tone: "red", icon: CircleX, label: "Failed run" },
  "agent-question": { tone: "amber", icon: MessageCircleQuestion, label: "Question" },
  "ready-for-review": { tone: "amber", icon: Eye, label: "Ready for review" },
  "conflicting-work": { tone: "red", icon: TriangleAlert, label: "Conflicting work" },
  inspection: { tone: "violet", icon: Lightbulb, label: "Suggestion" },
  "meeting-promise": { tone: "amber", icon: Handshake, label: "Your promise" },
  "client-idea": { tone: "violet", icon: Lightbulb, label: "Client idea" },
};

export type InboxCategory = "decision" | "ready" | "waiting";
export const INBOX_CATEGORY: Readonly<Record<InboxCategory, StatusSpec>> = {
  decision: { tone: "amber", icon: MessageCircleQuestion, label: "Needs decision" },
  ready: { tone: "blue", icon: CirclePlay, label: "Ready to work" },
  waiting: { tone: "gray", icon: Clock, label: "Waiting" },
};

export const PROMISE_GROUP: Readonly<Record<PromiseGroup, StatusSpec>> = {
  overdue: { tone: "red", icon: ClockAlert, label: "Overdue" },
  due_soon: { tone: "amber", icon: CalendarClock, label: "Due soon" },
  open: { tone: "blue", icon: CircleDot, label: "Open" },
  looks_done: { tone: "violet", icon: CircleHelp, label: "Looks done?" },
};

export const PROMISE_STATE: Readonly<Record<PromiseStateName, StatusSpec>> = {
  overdue: { tone: "red", icon: ClockAlert, label: "Overdue" },
  due_soon: { tone: "amber", icon: CalendarClock, label: "Due soon" },
  not_followed_up: { tone: "amber", icon: Eye, label: "No work since the call" },
  open: { tone: "blue", icon: CircleDot, label: "Open" },
};

export const ITEM_STATUS: Readonly<Record<ItemStatus, StatusSpec>> = {
  open: { tone: "blue", icon: CircleDot, label: "Open" },
  planned: { tone: "blue", icon: ListChecks, label: "Planned" },
  looks_done: { tone: "violet", icon: CircleHelp, label: "Looks done?" },
  done: { tone: "green", icon: CircleCheck, label: "Done" },
  dropped: { tone: "gray", icon: CircleSlash, label: "Dropped" },
};

export const ITEM_KIND: Readonly<Record<ItemKind, StatusSpec>> = {
  commitment: { tone: "amber", icon: Handshake, label: "Promise" },
  suggestion: { tone: "violet", icon: Lightbulb, label: "Suggestion" },
  pain_point: { tone: "red", icon: MessageSquareWarning, label: "Pain point" },
  decision: { tone: "blue", icon: Gavel, label: "Decision" },
};

export const MEETING_STATUS: Readonly<Record<MeetingStatus, StatusSpec>> = {
  waiting: { tone: "gray", icon: Clock, label: "Waiting" },
  unavailable: { tone: "gray", icon: CloudOff, label: "Unavailable" },
  skipped: { tone: "gray", icon: CircleSlash, label: "Skipped" },
  imported: { tone: "blue", icon: CircleDashed, label: "Imported, not analyzed" },
  analyzed: { tone: "green", icon: CircleCheck, label: "Analyzed" },
  failed: { tone: "red", icon: CircleX, label: "Failed" },
  forgotten: { tone: "gray", icon: Ban, label: "Forgotten" },
};

export type ConnectionState = "connected" | "disconnected" | "pending" | "error" | "invalid-key" | "paused";
export const CONNECTION: Readonly<Record<ConnectionState, StatusSpec>> = {
  connected: { tone: "green", icon: Plug, label: "Connected" },
  disconnected: { tone: "gray", icon: Unplug, label: "Not connected" },
  pending: { tone: "blue", icon: LoaderCircle, label: "Connecting", spin: true },
  error: { tone: "red", icon: CircleX, label: "Unavailable" },
  "invalid-key": { tone: "red", icon: KeyRound, label: "Key rejected" },
  paused: { tone: "gray", icon: Clock, label: "Paused" },
};
