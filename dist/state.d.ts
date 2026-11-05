import type { EntryId } from "@earendil-works/pi-durable";
/**
 * The escalation key / call fingerprint: `warden:` + the first 16 hex of
 * sha256(tool + "\n" + canonical JSON of the arguments, keys sorted).
 * Canonicalization is recursive so argument order never splits a grant.
 */
export declare function grantKey(tool: string, args: Record<string, unknown>): string;
export interface ConversationState {
    /** The newest user-input entry of the current run (run boundary). Serialized as a number. */
    runStart?: EntryId;
    /** Set when a deny/destructive call was blocked this run (Task 14/15). */
    tainted?: boolean;
    steers: number;
    /**
     * Held calls, kept across runs for 24 h, consumed on release.
     * `afterEntry` carries the hold NONCE (the interaction callId suffix:
     * `warden-<fingerprint>-<nonce>`); `status` tracks the hold lifecycle:
     * pending → answered (consumed) → released (one call released).
     */
    blocked: {
        fingerprint: string;
        at: string;
        afterEntry?: string;
        status?: "pending" | "answered" | "released";
    }[];
    /** Answered allows consumed once; a reply releases one call. */
    released: {
        fingerprint: string;
        replyEntry: string;
    }[];
    /** One in-flight execution per grant (job presence). */
    reservations: {
        grantKey: string;
        callId: string;
        escalationId: string;
    }[];
}
export declare function emptyState(): ConversationState;
/**
 * The on-disk store. `update` runs `fn` under a per-conversation
 * in-process lock and persists the result atomically. A change of
 * `runStart` (a new run) resets the run-scoped fields — `steers` and
 * `taint` — while 24 h `blocked` records and `reservations` persist;
 * `released` entries prune with their blocked record.
 */
export declare class StateStore {
    #private;
    constructor(stateDir: string, now?: () => Date);
    load(id: number): Promise<ConversationState>;
    update<T>(id: number, fn: (s: ConversationState) => T | Promise<T>): Promise<T>;
}
