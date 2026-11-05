/**
 * The per-target card check (warden spec §3.2, Task 14): a CLEARED
 * destructive job call runs autonomously only when the decision model
 * confirms, for EVERY target, that the run's evidence shows the target
 * meets a governing card's allow rule and no card says to escalate for
 * it. One DecisionRequest carries two noul questions per target:
 * `t<i>_meets` and `t<i>_escalate`.
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Judge } from "pi-typesafe";
import type { Card } from "./cards.js";
export type CardCheckResult = {
    pass: true;
    scores: Record<string, number>;
} | {
    pass: false;
    failing: readonly string[];
    reasons: readonly string[];
} | {
    pass: "unjudgeable";
    reason: string;
};
export interface CardCheckInput {
    judge: Judge;
    /** The governing card texts (each card's `text`). */
    cards: readonly Card[];
    call: ToolHookCall;
    /** The tool's MCP name when it is an MCP tool (the card's heading). */
    mcpName?: string;
    targets: readonly string[];
    /** This run's redacted evidence texts (evidenceFor). */
    evidence: readonly string[];
    /** The card threshold (settings.thresholds.card). */
    threshold: number;
}
/**
 * Judge every target against the governing cards. A target passes when
 * `t<i>_meets` ≥ threshold and `t<i>_escalate` < threshold. All pass →
 * `{pass: true, scores}`. Any fail → `{pass: false}` naming the failing
 * targets and the lowest-scoring question per target. A judge failure
 * (a throw, including `bad_answer` surfacing through decisionsJudge) →
 * `{pass: "unjudgeable"}`.
 */
export declare function cardCheck(input: CardCheckInput): Promise<CardCheckResult>;
