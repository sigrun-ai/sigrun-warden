/**
 * Where the tool call is happening (warden spec §3.2 presence classes):
 * an internal curator run, a scheduled job run, or a live conversation.
 */
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
export type Presence = {
    kind: "live";
    owner?: string;
} | {
    kind: "job";
    jobId: string;
    owner?: string;
} | {
    kind: "internal";
};
/**
 * Classify the conversation the hook is running in. `meta.internal` wins
 * (a curator run never escalates); otherwise the job whose fire is
 * currently running in this conversation decides job-vs-live.
 */
export declare function presenceOf(host: SigrunHost, conversationId: ConversationId): Promise<Presence>;
/** The current run's context, from the newest user input entry. */
export interface RunInfo {
    /** The newest user-input entry (this run's start), absent when none. */
    runStart: EntryId | undefined;
    /** The newest user input's text ("" when unreachable). */
    request: string;
    /** The tail of `request` (last 3000 chars) for prompt-style use. */
    asked: string;
    /** This run's entries (from `runStart` on), oldest first. */
    entries: readonly EntryRecord[];
}
/**
 * Read the run a held call belongs to. Tolerant by contract: it feeds
 * the judge's clear-ask input (Task 12), so an unreadable history yields
 * an empty run rather than throwing (beforeTool never fails through it —
 * the hook still wraps everything, but this keeps the failure mode a
 * simple degraded context).
 */
export declare function runInfo(host: SigrunHost, conversationId: ConversationId): Promise<RunInfo>;
