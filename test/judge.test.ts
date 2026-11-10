/**
 * Task 12 judge-adapter tests: `decisionsJudge` over
 * `host.decisions.evaluate`, the raw Evaluation pass-through, the
 * throw-on-ok:false mapping, the decision-model pass-through, and the
 * 3-failures → 5-minute Cooldown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Cooldown, decisionsJudge } from "../src/judge.js";
import { defaultSettings } from "../src/settings-schema.js";
import type { WardenSettings } from "../src/settings-schema.js";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";

const REQUEST = {
	state: { request: "Please remove torrents 7 and 9", call: '{"ids":[7,9]}' },
	questions: {
		clear_ask: {
			type: "noul",
			instructions: "Did the person ask for this action on exactly the targets in `call`?",
		},
	},
} as never;

const OK_RESULT = {
	ok: true,
	model: "acme/model-1",
	answers: { clear_ask: { type: "noul", noul: 0.95 } },
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 42,
};

function settingsWith(patch: Partial<WardenSettings>): WardenSettings {
	return { ...defaultSettings(), ...patch };
}

describe("decisionsJudge", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
		vi.useRealTimers();
	});

	it("ok answers pass through as the raw Evaluation shape", async () => {
		fake = await createFakeHost({ decisionResults: [OK_RESULT] });
		const cooldown = new Cooldown();
		const judge = decisionsJudge(fake.host, defaultSettings(), cooldown);
		expect(judge).toBeDefined();
		const result = await judge!.evaluate(REQUEST);
		expect(result.answers).toEqual(OK_RESULT.answers);
		expect(result.usage).toEqual(OK_RESULT.usage);
		expect(result.model).toBe("acme/model-1");
		expect(result.elapsedMs).toBe(42);
		// A success keeps the cooldown clear.
		expect(cooldown.active).toBe(false);
	});

	it("ok:false not_configured throws and counts a failure", async () => {
		fake = await createFakeHost({
			decisionResults: [{ ok: false, code: "not_configured", error: "no decision providers are configured" }],
		});
		const cooldown = new Cooldown();
		const judge = decisionsJudge(fake.host, defaultSettings(), cooldown)!;
		await expect(judge.evaluate(REQUEST)).rejects.toThrow(
			"not_configured: no decision providers are configured",
		);
		// One failure: the cooldown is not yet active; a second failure and a
		// third flip it on.
		expect(cooldown.active).toBe(false);
	});

	it("3 failures activate a 5-minute cooldown", async () => {
		fake = await createFakeHost({
			decisionResults: [{ ok: false, code: "failed", error: "boom" }],
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
		const cooldown = new Cooldown();
		const judge = decisionsJudge(fake.host, defaultSettings(), cooldown)!;
		for (let i = 0; i < 3; i += 1) {
			await expect(judge.evaluate(REQUEST)).rejects.toThrow("failed: boom");
		}
		expect(cooldown.active).toBe(true);
		// While active, decisionsJudge declines to produce a judge.
		expect(decisionsJudge(fake.host, defaultSettings(), cooldown)).toBeUndefined();
		// Still active just before the 5-minute mark; clear after it.
		vi.setSystemTime(new Date("2026-11-05T00:04:59Z"));
		expect(cooldown.active).toBe(true);
		vi.setSystemTime(new Date("2026-11-05T00:05:01Z"));
		expect(cooldown.active).toBe(false);
		expect(decisionsJudge(fake.host, defaultSettings(), cooldown)).toBeDefined();
	});

	it("a success resets the failure streak", async () => {
		fake = await createFakeHost({
			decisionResults: [
				{ ok: false, code: "failed", error: "boom" },
				{ ok: false, code: "failed", error: "boom" },
				OK_RESULT,
				{ ok: false, code: "failed", error: "boom" },
			],
		});
		const cooldown = new Cooldown();
		const judge = decisionsJudge(fake.host, defaultSettings(), cooldown)!;
		await expect(judge.evaluate(REQUEST)).rejects.toThrow();
		await expect(judge.evaluate(REQUEST)).rejects.toThrow();
		await judge.evaluate(REQUEST); // success resets
		await expect(judge.evaluate(REQUEST)).rejects.toThrow();
		expect(cooldown.active).toBe(false);
	});

	it("decisionModel setting is passed as model", async () => {
		fake = await createFakeHost({ decisionResults: [OK_RESULT] });
		const judge = decisionsJudge(
			fake.host,
			settingsWith({ decisionModel: "acme/model-9" }),
			new Cooldown(),
		)!;
		await judge.evaluate(REQUEST);
		expect(fake.decisionCalls).toHaveLength(1);
		expect(fake.decisionCalls[0]!.opts).toEqual({ model: "acme/model-9", signal: undefined });
	});

	it("judge.enabled false → no decision request is ever made", async () => {
		fake = await createFakeHost({ decisionResults: [OK_RESULT] });
		const judge = decisionsJudge(
			fake.host,
			settingsWith({ judge: { enabled: false } }),
			new Cooldown(),
		);
		expect(judge).toBeUndefined();
		expect(fake.decisionCalls).toHaveLength(0);
	});
});
