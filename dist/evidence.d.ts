import type { RunInfo } from "./context.js";
/** The default card-check evidence budget (one DecisionRequest's worth). */
export declare const EVIDENCE_BUDGET_BYTES = 16384;
/**
 * This run's tool-result texts mentioning any target, redacted, newest
 * first, trimmed to `budgetBytes` (an item that overflows the remaining
 * budget is dropped whole — no partial lines).
 */
export declare function evidenceFor(run: RunInfo, targets: readonly string[], budgetBytes: number): string[];
