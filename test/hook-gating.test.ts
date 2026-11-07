/**
 * pi-durable 1.5.0 hook gating (spec §3.2-b): the harness runs
 * afterTool on results it wrote for calls that NEVER executed —
 * blocked, invalid_arguments, tool_unavailable, ... — where
 * `call.arguments` may be raw unvalidated model text. The warden's
 * afterTool must early-return: no grant resolution, no stuck count,
 * and the result passes through unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
	Context,
} from "@earendil-works/chord";
import type {
	HookApi,
	ToolExecutionResult,
	ToolHookCall,
} from "@earendil-works/pi-durable";

import createWarden from "../src/index.js";
import { toolExecuted, HARNESS_RESULT_CODES } from "../src/tool-executed.js";
import { grantKey, StateStore } from "../src/state.js";
import {
	createFakeEscalations,
	createFakeHost,
	userEntry,
	assistantEntry,
} from "./fake-host.js";

function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

function apiFor(conversationId: number): HookApi {
	return { conversationId } as unknown as HookApi;
}

/** The fakes created this test file, cleaned up after each test. */
const fakes: { cleanup: () => Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(fakes.map((fake) => fake.cleanup()));
	fakes.length = 0;
});

/** The warden extension's registered ToolTask afterTool handler. */
async function wardenAfterTool() {
	const escalations = createFakeEscalations(true);
	const fake = await createFakeHost({
		owner: "alice",
		metaJobId: "ext:acme:cleanup",
		activeRun: { jobId: "ext:acme:cleanup", owner: "alice" },
		entries: [userEntry("clean up done torrents"), assistantEntry()],
		escalations,
	});
	fakes.push(fake);
	const result = createWarden(fake.host);
	const hooks = result.extension?.hooks ?? [];
	const registration = hooks.find((entry) => "afterTool" in entry.handlers);
	if (registration === undefined) throw new Error("no afterTool hook registered");
	const afterTool = (registration.handlers as {
		afterTool: (
			call: ToolHookCall,
			result: ToolExecutionResult,
			api: HookApi,
			context: Context,
		) => Promise<ToolExecutionResult | undefined>;
	}).afterTool;
	return { afterTool, fake, escalations };
}

describe("toolExecuted", () => {
	it("is false for every harness-written result code", () => {
		for (const code of HARNESS_RESULT_CODES) {
			expect(
				toolExecuted({
					output: [{ type: "text", text: "err" }],
					isError: true,
					diagnostics: [{ severity: "error", message: "err", code }],
				}),
			).toBe(false);
		}
	});

	it("is true for a result with no harness diagnostic codes", () => {
		expect(toolExecuted({ output: [{ type: "text", text: "ok" }] })).toBe(true);
		expect(
			toolExecuted({
				output: [{ type: "text", text: "ok" }],
				diagnostics: [{ severity: "warn", message: "truncated", code: "truncated" }],
			}),
		).toBe(true);
	});
});

describe("afterTool on a result the harness wrote (the call never ran)", () => {
	it("a blocked result resolves no grant, keeps the reservation, and returns the result unchanged", async () => {
		const { afterTool, fake } = await wardenAfterTool();
		const call: ToolHookCall = {
			type: "toolCall",
			id: "c1",
			name: "acme-media/torrents_remove",
			arguments: { ids: [7] },
		} as ToolHookCall;
		// Seed the reservation the granted call left when beforeTool let it
		// run — a blocked result (the call NEVER ran) must not consume it.
		const store = new StateStore(`${fake.root}/state`);
		await store.update(1 as never, (state) => {
			state.reservations.push({
				grantKey: grantKey("acme-media/torrents_remove", { ids: [7] }),
				callId: "c1",
				escalationId: "esc-1",
			});
			return state;
		});
		const blocked: ToolExecutionResult = {
			output: [{ type: "text", text: "held" }],
			isError: true,
			diagnostics: [{ severity: "error", message: "held", code: "blocked" }],
		};
		const returned = await afterTool(call, blocked, apiFor(1), liveContext());
		// The result passes through unchanged (the hook returns undefined).
		expect(returned).toBeUndefined();
		// No grant resolution was attempted: escalation.resolve never ran
		// and the reservation is still pending (the real execution's
		// afterTool must still find it).
		expect(
			fake.publishedHooks.calls.filter((entry) => entry.name === "escalation.resolve"),
		).toEqual([]);
		const state = await store.load(1 as never);
		expect(state.reservations).toHaveLength(1);
		// The stuck counter never saw it: the conversation state carries no
		// new taint/blocked record from a result the harness wrote.
		});

	it("an invalid_arguments result with raw-string arguments does not throw", async () => {
		const { afterTool } = await wardenAfterTool();
		const call: ToolHookCall = {
			type: "toolCall",
			id: "c2",
			name: "bash",
			// Raw unvalidated model text — NOT the parsed object shape.
			arguments: "rm -rf /tmp/x" as never,
		} as ToolHookCall;
		const invalid: ToolExecutionResult = {
			output: [{ type: "text", text: "invalid arguments" }],
			isError: true,
			diagnostics: [
				{ severity: "error", message: "invalid arguments", code: "invalid_arguments" },
			],
		};
		await expect(afterTool(call, invalid, apiFor(1), liveContext())).resolves.toBeUndefined();
	});
});
