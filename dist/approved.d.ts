/**
 * Calls a person approved on a claimed escalation (the exact-call bridge):
 * an escalation option may declare the tool calls it authorizes, and once
 * a job run has claimed the answered item, those calls run without a card
 * check or a second (warden) escalation.
 *
 * A call matches an approved call when the tool name is identical and:
 * - both carry the same target list argument (the first non-empty
 *   array-of-scalars, targets.ts): every other argument is identical and
 *   the call's targets are a subset of the approved ones (so the forced
 *   16-target splits of a larger approval still match); or
 * - otherwise, the arguments are identical.
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
export interface ApprovedCall {
    /** The approving escalation's id. */
    readonly id: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
}
/** The approved call that authorizes `call`, or undefined. */
export declare function approvalFor(call: Pick<ToolHookCall, "name" | "arguments">, approved: readonly ApprovedCall[]): ApprovedCall | undefined;
