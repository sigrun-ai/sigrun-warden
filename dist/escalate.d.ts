/**
 * The job-presence grant path over the escalations extension's published
 * hooks (`escalation.raise`/`take`/`resolve`, Task 9). The escalation
 * key IS the grant key (`warden:` + fingerprint); the hooks bucket by
 * the conversation owner, which for a job-fire conversation is the job's
 * effective owner (core Task 3).
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
export interface RaiseResult {
    readonly status: string;
    readonly id?: string;
    readonly created?: boolean;
}
export interface TakeResult {
    readonly status: "none" | string;
    readonly id?: string;
    readonly option?: string;
}
export interface ResolveResult {
    readonly status: string;
}
/** The human-facing body of a raised hold: tool, redacted args, reasons. */
export declare function escalationBody(call: Pick<ToolHookCall, "name" | "arguments">, reasons: readonly string[]): string;
/** Test hook: reset the once-per-process no-provider warning. */
export declare function resetNoProviderWarning(): void;
/**
 * Raise (or dedup) the hold as an escalation item. With no escalation
 * provider the hold still surfaces: a notice to the job's owner keyed
 * by the grant key (skipped when the job has no owner), plus one
 * console.warn per process.
 */
export declare function raiseEscalation(host: SigrunHost, call: Pick<ToolHookCall, "name" | "arguments">, key: string, jobId: string, owner: string | undefined, reasons: readonly string[], conversationId: ConversationId): Promise<RaiseResult>;
/** Claim an answered item for the calling conversation (or report none). */
export declare function takeGrant(host: SigrunHost, key: string, jobId: string, conversationId: ConversationId): Promise<TakeResult>;
/** Resolve a claimed item after carrying out its answer. */
export declare function resolveGrant(host: SigrunHost, id: string, outcome: "done" | "failed", note: string, conversationId: ConversationId): Promise<ResolveResult>;
