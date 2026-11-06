/**
 * The live-presence hold: an interaction record (kind `warden.confirm`)
 * seeded idempotently by CALL FINGERPRINT, so a crash re-entry or a
 * retry with a new tool-call id waits on the same question — never a
 * second card.
 */
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { redact } from "pi-warden";
import { argumentsMarkdown } from "./argsmd.js";
import {
	choice,
	form,
	longtext,
	markdown,
	section,
	tree,
} from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";

/** The interaction kind the warden declares (loader-validated). */
export const WARDEN_CONFIRM_KIND = "warden.confirm";

/** Poll cadence while a person decides (the fixture-gate shape). */
const POLL_MS = 500;

/**
 * The allow/deny gate body: markdown context naming the tool and its
 * redacted arguments plus the reasons, then a Decision section with a
 * `choice` (allow/deny) and a `longtext` reason. Mirrors the
 * `gatingConfirmBody` example in core's docs/extending.md.
 */
export function confirmBody(
	call: Pick<ToolHookCall, "name" | "arguments">,
	reasons: readonly string[],
): Tree {
	const reasonLines = reasons.map((reason) => `- ${reason}`).join("\n");
	return tree(
		form({
			id: "warden-confirm",
			bind: "/values",
			mode: "submit",
			submitLabel: "Send",
			children: [
				section({
					title: "Confirm",
					children: [
						markdown({
							text: `The warden held \`${call.name}\`.\n\n${argumentsMarkdown(call)}\n\n${reasonLines}`,
						}),
					],
				}),
				section({
					title: "Decision",
					children: [
						choice({
							name: "decision",
							label: "Allow this call?",
							options: [
								{ id: "allow", label: "Allow", tone: "good" },
								{ id: "deny", label: "Deny", tone: "bad" },
							],
						}),
						longtext({
							name: "reason",
							label: "Why (optional)",
							placeholder: "Recorded with the hold.",
						}),
					],
				}),
			],
		}),
	);
}

/**
 * Seed the question and long-poll for the answer. The record callId is
 * `"warden-" + fingerprint(16 hex)`; seeding is first-write-wins, so
 * concurrent or repeated holds of identical calls share ONE card. The
 * poll sleeps cancellation-safely so abort/close unwinds the held call.
 * Consumption of an answered allow (exactly one call per reply) is a
 * state concern, handled by the caller (route.ts).
 *
 * @returns the decision and the person's reason text ("" when absent).
 */
export async function holdForPerson(
	host: SigrunHost,
	call: Pick<ToolHookCall, "name" | "arguments">,
	conversationId: ConversationId,
	fingerprint: string,
	reasons: readonly string[],
	context: Context,
): Promise<{ answer: "allow" | "deny"; reason: string }> {
	const callId = `warden-${fingerprint}`;
	await host.seedInteraction(
		conversationId,
		{
			kind: WARDEN_CONFIRM_KIND,
			callId,
			status: "pending",
			createdAt: Date.now(),
			body: confirmBody(call, reasons),
			details: {
				toolName: call.name,
				arguments: JSON.parse(redact(JSON.stringify(call.arguments))) as JsonObject,
			},
		},
		context,
	);
	for (;;) {
		const record = await host.snapshotInteraction(conversationId, callId, context);
		if (record?.status === "answered") {
			const decision = record.answer?.values.decision;
			const reason = record.answer?.values.reason;
			return {
				answer: decision === "allow" ? "allow" : "deny",
				reason: typeof reason === "string" ? reason : "",
			};
		}
		await awaitWithContext(
			new Promise((resolve) => setTimeout(resolve, POLL_MS)),
			context,
		);
	}
}
