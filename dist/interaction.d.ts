import type { Context } from "@earendil-works/chord";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Tree } from "@sigrun/sigrun/blocks";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
/** The interaction kind the warden declares (loader-validated). */
export declare const WARDEN_CONFIRM_KIND = "warden.confirm";
/**
 * The allow/deny gate body: markdown context naming the tool and its
 * redacted arguments plus the reasons, then a Decision section with a
 * `choice` (allow/deny) and a `longtext` reason. Mirrors the
 * `gatingConfirmBody` example in core's docs/extending.md.
 */
export declare function confirmBody(call: Pick<ToolHookCall, "name" | "arguments">, reasons: readonly string[]): Tree;
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
export declare function holdForPerson(host: SigrunHost, call: Pick<ToolHookCall, "name" | "arguments">, conversationId: ConversationId, fingerprint: string, reasons: readonly string[], context: Context): Promise<{
    answer: "allow" | "deny";
    reason: string;
}>;
