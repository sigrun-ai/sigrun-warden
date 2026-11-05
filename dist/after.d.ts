/**
 * Task 15 afterTool guards, run AFTER the Task 13 card build and the
 * Task 11 grant resolution in `index.ts`:
 *
 * 1. Masking — `redact` every text part of the result; a replaced result
 *    is returned only when something actually changed.
 * 2. Planted instructions — results of MCP tools (`/` in the name) and
 *    of any tool whose text output exceeds 200 chars are asked the
 *    pi-warden `securityQuestion` (over the redacted text). A firing
 *    judgment TAINTS the run (`state.tainted = true`) and appends the
 *    planted-instructions notice. With no decision model the check is
 *    skipped (masking still runs). A THROWN judgment is treated like
 *    no-model for that call — the check could not run, so it is skipped
 *    (no taint): the Cooldown counts the failure through the shared
 *    decisionsJudge, and the masking + the rest of the warden still
 *    guard. (Fail-open for the DETECTION, by design — the taint itself
 *    is a state mutation the caller can never see, so a judge outage
 *    silently tainting every long output would be worse.)
 * 3. Stuck — `makeAttempt` into a per-run `AttemptWindow`; when
 *    `exactRepeats() >= 3` on a failing attempt (code only, no judge)
 *    the stuck notice is appended.
 *
 * Both notices are non-critical: each counts against the run's
 * `steerBudget`; past the budget the notice goes to the hold log only
 * (the appended text is dropped). The TAINT itself always lands — the
 * state mutation is not budgeted, only the notice text is.
 */
import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Judge } from "pi-typesafe";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { RunInfo } from "./context.js";
import type { HoldLog } from "./log.js";
import type { WardenSettings } from "./settings.js";
import type { StateStore } from "./state.js";
/** The context the afterTool pipeline hands the guard (Task 11 shape). */
export interface AfterContext {
    host: SigrunHost;
    conversationId: ConversationId;
    run: RunInfo;
    settings: WardenSettings;
    store: StateStore;
    log: HoldLog;
    /** The decisions judge (Task 12); `undefined` when disabled/cooling. */
    judge?: Judge;
    context: Context;
}
/** Test hook: drop every per-run attempt window. */
export declare function resetAttemptWindowsForTests(): void;
/**
 * The afterTool guard chain. Returns a REPLACED result (masked, and/or
 * with a notice appended) or undefined when the result stands as-is.
 */
export declare function afterToolGuard(call: ToolHookCall, result: ToolExecutionResult, ctx: AfterContext): Promise<ToolExecutionResult | undefined>;
