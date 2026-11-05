/**
 * The job-presence grant path over the escalations extension's published
 * hooks (`escalation.raise`/`take`/`resolve`, Task 9). The escalation
 * key IS the grant key (`warden:` + fingerprint); the hooks bucket by
 * the conversation owner, which for a job-fire conversation is the job's
 * effective owner (core Task 3).
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { redact } from "pi-warden";
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
export function escalationBody(
	call: Pick<ToolHookCall, "name" | "arguments">,
	reasons: readonly string[],
): string {
	const redactedArgs = redact(JSON.stringify(call.arguments));
	const reasonLines = reasons.map((reason) => `- ${reason}`).join("\n");
	return `The warden held \`${call.name}\` in a job run.\n\nArguments:\n\`\`\`json\n${redactedArgs}\n\`\`\`\n\n${reasonLines}`;
}

/** One boot-scoped warning when job holds have no inbox to land in. */
let warnedNoProvider = false;

/** Test hook: reset the once-per-process no-provider warning. */
export function resetNoProviderWarning(): void {
	warnedNoProvider = false;
}

/**
 * Raise (or dedup) the hold as an escalation item. With no escalation
 * provider the hold still surfaces: a notice to the job's owner keyed
 * by the grant key (skipped when the job has no owner), plus one
 * console.warn per process.
 */
export async function raiseEscalation(
	host: SigrunHost,
	call: Pick<ToolHookCall, "name" | "arguments">,
	key: string,
	jobId: string,
	owner: string | undefined,
	reasons: readonly string[],
	conversationId: ConversationId,
): Promise<RaiseResult> {
	const body = escalationBody(call, reasons);
	const result = (await host.publishedHooks.call(
		"escalation.raise",
		{
			key,
			title: `Held: ${call.name}`,
			body,
			options: [
				{ id: "approve", label: "Approve and run once" },
				{ id: "decline", label: "Decline" },
			],
			allowInstruction: false,
			onAnswer: "next-run",
			jobId,
		},
		{ conversationId },
	)) as { status: string; id?: string; created?: boolean } | { status: "absent" };

	if (result.status === "absent") {
		if (!warnedNoProvider) {
			warnedNoProvider = true;
			console.warn(
				"warden: no escalation provider; job holds have no inbox (surface via notices)",
			);
		}
		if (owner !== undefined) {
			await host.notices.post({
				user: owner,
				key,
				title: `Held: ${call.name}`,
				body,
				tone: "warn",
			});
		}
		return { status: "absent" };
	}
	const ok = result as { status: string; id?: string; created?: boolean };
	return { status: ok.status, id: ok.id, created: ok.created };
}

/** Claim an answered item for the calling conversation (or report none). */
export async function takeGrant(
	host: SigrunHost,
	key: string,
	jobId: string,
	conversationId: ConversationId,
): Promise<TakeResult> {
	const result = (await host.publishedHooks.call(
		"escalation.take",
		{ key, jobId },
		{ conversationId },
	)) as { status: string; id?: string; option?: string };
	// A missing provider answers `absent`; that is NOT a grant in a
	// non-approving state (the caller's `!== "none"` gate would read it as
	// one and never reach the clearance path — the Task 16 e2e regression).
	// Absence maps to `none`: no inbox, no grant, keep going.
	if (result.status === "absent") return { status: "none" };
	return {
		status: result.status,
		...(result.id === undefined ? {} : { id: result.id }),
		...(result.option === undefined ? {} : { option: result.option }),
	};
}

/** Resolve a claimed item after carrying out its answer. */
export async function resolveGrant(
	host: SigrunHost,
	id: string,
	outcome: "done" | "failed",
	note: string,
	conversationId: ConversationId,
): Promise<ResolveResult> {
	const result = (await host.publishedHooks.call(
		"escalation.resolve",
		{ id, outcome, note },
		{ conversationId },
	)) as { status: string };
	return { status: result.status };
}
