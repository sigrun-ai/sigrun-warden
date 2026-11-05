/**
 * Routing without a decision model (warden spec §3.2): deny blocks in
 * every presence; internal blocks curators outright; live holds a call
 * on an interaction question; job holds block + escalate with one-shot
 * grants. The judge (Task 12) and clearances (Task 14) slot in later —
 * without a decision model a cleared call takes the block path too.
 */
import type { Context } from "@earendil-works/chord";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Classification } from "./classify.js";
import type { Presence, RunInfo } from "./context.js";
import type { StateStore } from "./state.js";
import type { HoldLog } from "./log.js";
import type { WardenSettings } from "./settings.js";
import type { Judge } from "pi-typesafe";
import { Cooldown } from "./judge.js";
export interface RouteInput {
    host: SigrunHost;
    call: ToolHookCall;
    conversationId: ConversationId;
    classification: Classification;
    presence: Presence;
    run: RunInfo;
    settings: WardenSettings;
    store: StateStore;
    log: HoldLog;
    /** The hook's own chord context (the interaction poll cancels with it). */
    context: Context;
    /**
     * The decisions judge (Task 12), set by the factory; when present the
     * live path judges destructive calls. `routeOffline` ignores it.
     */
    judge?: Judge;
    cooldown?: Cooldown;
}
/**
 * Route one classified call. Returns `{block}` to block, undefined to
 * allow. Nested calls (`call.parent` set — codemode/executeTool) route
 * EXACTLY like model-issued calls: no special-casing.
 */
export declare function routeOffline(input: RouteInput): Promise<{
    block?: string;
} | undefined>;
export interface AfterGrantContext {
    host: SigrunHost;
    call: ToolHookCall;
    conversationId: ConversationId;
    result: {
        isError?: boolean;
    };
    store: StateStore;
}
/**
 * The Task-11 slice of afterTool: resolve the grant this call's
 * reservation names and drop the reservation. The planted-instructions /
 * masking / stuck guards are Task 15 and are omitted here entirely.
 */
export declare function resolveReservedGrant(input: AfterGrantContext): Promise<void>;
/** Test hook: reset the once-per-process prune guard. */
export declare function resetPruneGuardForTests(): void;
/** Kick `log.prune` exactly once per process; failures go to console.warn. */
export declare function startPruneOnce(log: HoldLog, retentionDays: WardenSettings["retentionDays"]): void;
