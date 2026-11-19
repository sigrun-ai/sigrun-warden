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
import { canonicalize, targetKeyOf } from "./targets.js";

export interface ApprovedCall {
	/** The approving escalation's id. */
	readonly id: string;
	readonly tool: string;
	readonly arguments: Record<string, unknown>;
}

/** The approved call that authorizes `call`, or undefined. */
export function approvalFor(
	call: Pick<ToolHookCall, "name" | "arguments">,
	approved: readonly ApprovedCall[],
): ApprovedCall | undefined {
	return approved.find((entry) => entry.tool === call.name && matches(call.arguments, entry.arguments));
}

function matches(args: Record<string, unknown>, approved: Record<string, unknown>): boolean {
	const key = targetKeyOf(args);
	if (key === undefined || key !== targetKeyOf(approved)) {
		return canonicalize(args) === canonicalize(approved);
	}
	const { [key]: targets, ...rest } = args;
	const { [key]: approvedTargets, ...approvedRest } = approved;
	if (canonicalize(rest) !== canonicalize(approvedRest)) return false;
	const allowed = new Set((approvedTargets as unknown[]).map(String));
	return (targets as unknown[]).every((target) => allowed.has(String(target)));
}
