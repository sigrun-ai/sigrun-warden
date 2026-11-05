export interface HoldRecord {
    /** ISO timestamp the record was stamped. */
    at: string;
    conversationId: number;
    owner?: string;
    jobId?: string;
    tool: string;
    /** Redacted JSON of the tool call. */
    call: string;
    action: "steer" | "hold" | "block" | "escalate" | "release" | "allow-judged" | "warn";
    scores?: Record<string, number>;
    outcome?: "approved" | "declined" | "replanned" | "escalated" | "abandoned";
}
export declare class HoldLog {
    #private;
    constructor(path: string, now: () => Date);
    append(record: HoldRecord): Promise<void>;
    /** The newest `n` records, oldest-first within the window. */
    recent(n: number): Promise<HoldRecord[]>;
    /**
     * Drop records older than their action's retention: hold/block/escalate
     * keep for `retention.holds` days, everything else for `retention.calls`.
     */
    prune(retention: {
        calls: number;
        holds: number;
    }): Promise<void>;
}
