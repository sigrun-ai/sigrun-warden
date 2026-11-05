import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import type { Context } from "@earendil-works/chord";

import { annotationFromHookResult, classify } from "./classify.js";
import { presenceOf, runInfo } from "./context.js";
import { Cooldown, decisionsJudge } from "./judge.js";
import { HoldLog } from "./log.js";
import {
	resolveReservedGrant,
	resetPruneGuardForTests,
	routeOffline,
	startPruneOnce,
} from "./route.js";
import { defaultSettings, parseSettings } from "./settings.js";
import { StateStore } from "./state.js";

/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 11 wires the ToolTask hook's beforeTool/afterTool for the
 * NO-decision-model path: live conversations hold a call on an
 * interaction question; job runs block + escalate (one-shot grants).
 * The judge (Task 12) and clearances (Task 14) slot in later.
 */
export default function createWarden(
	host: SigrunHost,
	deps: Record<string, never> = {},
): SigrunExtensionResult {
	void deps;
	const log = new HoldLog(
		`${host.stores.paths.state}/holds.jsonl`,
		() => new Date(),
	);
	const store = new StateStore(host.stores.paths.state);
	// Instance-wide judge cooldown (in memory — a restart re-trusts the judge).
	const cooldown = new Cooldown();

	const beforeTool = async (
		call: ToolHookCall,
		api: HookApi,
		context: Context,
	): Promise<{ readonly arguments?: JsonObject; readonly block?: string } | undefined> => {
		// The hook's contract: catch EVERYTHING and block — never let a
		// call through on an exception.
		try {
			const raw = await host.stores.settings.get();
			const settings = parseSettings(raw, (message) => console.warn(message));
			startPruneOnce(log, settings.retentionDays);

			const annotations = async (tool: string) =>
				annotationFromHookResult(
					tool,
					(await host.publishedHooks.call(
						"mcp.tool-annotations",
						{ tool },
						{ conversationId: api.conversationId },
					)) as { status: string },
				);
			const classification = await classify(
				{ name: call.name, arguments: call.arguments },
				{ annotations, settings },
			);
			const presence = await presenceOf(host, api.conversationId);
			const run = await runInfo(host, api.conversationId);
			const judge = decisionsJudge(host, settings, cooldown);
			return await routeOffline({
				host,
				call,
				conversationId: api.conversationId,
				classification,
				presence,
				run,
				settings,
				store,
				log,
				context,
				judge,
				cooldown,
			});
		} catch (error) {
			return { block: `warden error: ${errorMessage(error)}` };
		}
	};

	const afterTool = async (
		call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		_context: Context,
	): Promise<ToolExecutionResult | undefined> => {
		// Task 11 slice: resolve grants. Planted-instructions / masking /
		// stuck guards are Task 15 and are omitted here entirely.
		try {
			await resolveReservedGrant({
				host,
				call,
				conversationId: api.conversationId,
				result,
				store,
			});
		} catch (error) {
			console.warn("warden: afterTool grant resolution failed", error);
		}
		return undefined;
	};

	return {
		extension: defineExtension({
			name: "sigrun.warden",
			tools: [],
			hooks: [hook(ToolTask, { beforeTool, afterTool })],
		}),
		interactionKinds: ["warden.confirm"],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { parseSettings, defaultSettings, resetWarnedKeys } from "./settings.js";
export type { WardenSettings } from "./settings.js";
export { classify, annotationFromHookResult } from "./classify.js";
export type { AnnotationLookup, Classification, ClassifyDeps } from "./classify.js";
export { HoldLog } from "./log.js";
export type { HoldRecord } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
export { presenceOf, runInfo } from "./context.js";
export type { Presence, RunInfo } from "./context.js";
export { grantKey, StateStore } from "./state.js";
export type { ConversationState } from "./state.js";
export { confirmBody, holdForPerson, WARDEN_CONFIRM_KIND } from "./interaction.js";
export {
	escalationBody,
	raiseEscalation,
	resolveGrant,
	takeGrant,
} from "./escalate.js";
export {
	resetPruneGuardForTests,
	resolveReservedGrant,
	routeOffline,
	startPruneOnce,
} from "./route.js";
export type { RouteInput } from "./route.js";
export { Cooldown, decisionsJudge } from "./judge.js";
export { clearAskQuestion } from "./questions.js";
export { evaluateLive, judgeBashUnknown } from "./live.js";
export type { LiveInput, LiveOutcome } from "./live.js";
