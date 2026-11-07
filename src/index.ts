import { createHash } from "node:crypto";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import type { Context } from "@earendil-works/chord";

import { afterToolGuard } from "./after.js";
import { annotationFromHookResult, classify } from "./classify.js";
import { buildCard } from "./cards.js";
import { createWardenCommands } from "./commands.js";
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
import { toolExecuted } from "./tool-executed.js";

/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 11 wires the ToolTask hook's beforeTool/afterTool for the
 * NO-decision-model path: live conversations hold a call on an
 * interaction question; job runs block + escalate (one-shot grants).
 * The judge (Task 12) drives live calls; the clearance + card-check
 * path (Task 14) drives cleared job calls.
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
		// pi-durable 1.5.0 (spec §3.2-b): the harness runs afterTool on
		// results IT wrote for calls that never executed (blocked,
		// invalid_arguments, tool_unavailable, ...) — where
		// `call.arguments` may be raw unvalidated model text. Nothing
		// below may observe such a result: no grant resolution, no stuck
		// count, no card collection. `undefined` passes it through.
		if (!toolExecuted(result)) return undefined;
		// Task 13: a skill arriving in the run (a `load_skill` result or a
		// `read` of a SKILL.md path) starts a BACKGROUND card build —
		// single-flight per body hash; failures warn and never block.
		const skill = skillFromToolResult(call, result);
		if (skill !== undefined) {
			void (async () => {
				try {
					const raw = await host.stores.settings.get();
					const settings = parseSettings(raw, (message) => console.warn(message));
					const card = await buildCard(host, skill, settings);
					if (card === undefined) {
						console.warn(`warden: card build failed for ${skill.name}`);
					}
				} catch (error) {
					console.warn("warden: card build failed", error);
				}
			})();
		}
		// Task 11 slice: resolve grants.
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
		// Task 15, LAST in the pipeline (skill collection and grant
		// resolution above): masking → planted-instructions taint → stuck.
		// A thrown guard must never drop the tool's result.
		try {
			const raw = await host.stores.settings.get();
			const settings = parseSettings(raw, (message) => console.warn(message));
			const run = await runInfo(host, api.conversationId);
			return await afterToolGuard(call, result, {
				host,
				conversationId: api.conversationId,
				run,
				settings,
				store,
				log,
				judge: decisionsJudge(host, settings, cooldown),
				context: _context,
			});
		} catch (error) {
			console.warn("warden: afterTool guard failed", error);
			return undefined;
		}
	};

	return {
		extension: defineExtension({
			name: "sigrun.warden",
			tools: [],
			hooks: [hook(ToolTask, { beforeTool, afterTool })],
		}),
		interactionKinds: ["warden.confirm"],
		commands: createWardenCommands(host),
	};
}

/**
 * The skill a tool result introduces into the run, when it does: a
 * `load_skill` result (name from the call's args) or a `read` of a path
 * ending SKILL.md (name = the parent directory's leaf). The body is the
 * result's text.
 */
function skillFromToolResult(
	call: ToolHookCall,
	result: ToolExecutionResult,
): { name: string; location?: string; body: string; hash: string } | undefined {
	const text = toolResultText(result);
	if (text === "" || result.isError === true) return undefined;
	const args = call.arguments as Record<string, unknown>;
	if (call.name === "load_skill") {
		const name =
			typeof args.skill === "string"
				? args.skill
				: typeof args.name === "string"
					? args.name
					: undefined;
		if (name === undefined) return undefined;
		return { name, body: text, hash: bodyHash(text) };
	}
	if (call.name === "read" && typeof args.path === "string" && args.path.endsWith("SKILL.md")) {
		const segments = args.path.split("/").filter((part) => part.length > 0);
		const name = segments.length >= 2 ? segments[segments.length - 2]! : segments[0]!;
		return { name, location: args.path, body: text, hash: bodyHash(text) };
	}
	return undefined;
}

/** The concatenated text blocks of a tool result's output. */
function toolResultText(result: ToolExecutionResult): string {
	const output = result.output;
	if (typeof output === "string") return output;
	if (!Array.isArray(output)) return "";
	const parts: string[] = [];
	for (const block of output) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

function bodyHash(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
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
export { afterToolGuard, resetAttemptWindowsForTests } from "./after.js";
export type { AfterContext } from "./after.js";
export { Cooldown, decisionsJudge } from "./judge.js";
export { clearAskQuestion } from "./questions.js";
export { evaluateLive, judgeBashUnknown } from "./live.js";
export type { LiveInput, LiveOutcome } from "./live.js";
export { skillTagsInText, skillsInRun } from "./skills.js";
export type { SkillSeen, SkillTag } from "./skills.js";
export {
	buildCard,
	CARD_MAX_BYTES,
	CARD_SYSTEM_PROMPT,
	CARD_TIMEOUT_MS,
	CardStore,
	resetInflightForTests,
} from "./cards.js";
export type { Card } from "./cards.js";
export { createWardenCommands } from "./commands.js";
export { targetsOf } from "./targets.js";
export { EVIDENCE_BUDGET_BYTES, evidenceFor } from "./evidence.js";
export { cardCheck } from "./card-check.js";
export type { CardCheckInput, CardCheckResult } from "./card-check.js";
