/**
 * Task 12 live-path tests: the decisions judge over the live flow —
 * clear ask → run, vague ask → steer, approval on reply (one reply
 * releases exactly one execution), ignored steer → ask the person, and
 * the bash-unknown judgment (skip / irreversible / logged allow).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

import type { Classification } from "../src/classify.js";
import { runInfo } from "../src/context.js";
import type { RunInfo } from "../src/context.js";
import { Cooldown, decisionsJudge } from "../src/judge.js";
import { evaluateLive } from "../src/live.js";
import type { LiveInput } from "../src/live.js";
import { HoldLog } from "../src/log.js";
import { routeOffline } from "../src/route.js";
import { defaultSettings } from "../src/settings.js";
import { StateStore } from "../src/state.js";
import { createFakeHost, resetEntryIds, toolResultEntry, userEntry } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";

const CLEAR_TEXT = "Please remove torrents 7 and 9 with their data";

function callWith(id: string, name = "acme-media/torrents_remove"): ToolHookCall {
	return {
		type: "toolCall",
		id,
		name,
		arguments: name === "bash" ? { command: "make deploy" } : { ids: [7, 9] },
	} as ToolHookCall;
}

const DESTRUCTIVE: Classification = {
	kind: "destructive",
	reasons: ["MCP tool acme-media/torrents_remove is annotated destructive"],
	mcp: { server: "acme-media", mcpName: "torrents_remove" },
};

const BASH_UNKNOWN: Classification = { kind: "bash-unknown", command: "make deploy" };

function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

/** A tool-result entry of a tool named ask_user_question. */
function askUserResultEntry(text: string) {
	return {
		id: 0,
		conversationId: 0,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: "auq-1",
				toolName: "ask_user_question",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
			},
		],
	};
}

/** DecisionResult fixtures. */
const CLEAR_OK = {
	ok: true,
	model: "acme/model-1",
	answers: { clear_ask: { type: "noul", noul: 0.95 } },
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};
const CLEAR_NO = {
	ok: true,
	model: "acme/model-1",
	answers: { clear_ask: { type: "noul", noul: 0.2 } },
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};
const APPROVE_OK = {
	ok: true,
	model: "acme/model-1",
	answers: {
		approved: { type: "noul", noul: 0.95 },
		reply_points_at_action: { type: "noul", noul: 0.9 },
	},
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};
const APPROVE_NO = {
	ok: true,
	model: "acme/model-1",
	answers: {
		approved: { type: "noul", noul: 0.1 },
		reply_points_at_action: { type: "noul", noul: 0.9 },
	},
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};
const IRREVERSIBLE_YES = {
	ok: true,
	model: "acme/model-1",
	answers: { irreversible: { type: "noul", noul: 0.95 } },
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};
const IRREVERSIBLE_MID = {
	ok: true,
	model: "acme/model-1",
	answers: { irreversible: { type: "noul", noul: 0.6 } },
	usage: { input_tokens: 10, output_tokens: 2 },
	elapsedMs: 5,
};

interface LiveEnv {
	fake: FakeHost;
	log: HoldLog;
	store: StateStore;
	run: RunInfo;
	cooldown: Cooldown;
	input(over?: {
		classification?: Classification;
		presence?: LiveInput["presence"];
		call?: ToolHookCall;
		run?: RunInfo;
		judgeOff?: boolean;
	}): LiveInput;
}

async function liveEnv(
	options: Parameters<typeof createFakeHost>[0],
	conversationId = 1,
): Promise<LiveEnv> {
	const fake = await createFakeHost(options);
	const log = new HoldLog(`${fake.root}/state/holds.jsonl`, () => new Date());
	const store = new StateStore(`${fake.root}/state`);
	const run = await runInfo(fake.host, conversationId as never);
	const cooldown = new Cooldown();
	const input: LiveEnv["input"] = (over = {}) => ({
		host: fake.host,
		call: over?.call ?? callWith("c1"),
		conversationId: conversationId as never,
		classification: over?.classification ?? DESTRUCTIVE,
		presence: over?.presence ?? { kind: "live", owner: "alice" },
		run: over?.run ?? run,
		settings: defaultSettings(),
		store,
		log,
		context: liveContext(),
		judge: over?.judgeOff === true ? undefined : decisionsJudge(fake.host, defaultSettings(), cooldown),
		cooldown,
	});
	return { fake, log, store, run, cooldown, input };
}

beforeEach(() => {
	resetEntryIds();
});

describe("evaluateLive: the clear-ask judgment", () => {
	let env: LiveEnv | undefined;
	afterEach(async () => {
		await env?.fake.cleanup();
		env = undefined;
	});

	it('a clear ask ("remove torrents 7 and 9 with their data" + ids [7,9]) runs with no interaction', async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry(CLEAR_TEXT)],
			decisionResults: [CLEAR_OK],
		});
		const outcome = await evaluateLive(env.input());
		expect(outcome).toEqual({ action: "run" });
		// Exactly one judge call, the clear-ask question, redacted state.
		expect(env.fake.decisionCalls).toHaveLength(1);
		const request = env.fake.decisionCalls[0]!.request as {
			state: { request: string; call: string };
			questions: Record<string, { type: string }>;
		};
		expect(Object.keys(request.questions)).toEqual(["clear_ask"]);
		expect(request.state.request).toBe(CLEAR_TEXT);
		expect(request.state.call).toContain('"ids"');
		expect(env.fake.interactions.seeded).toHaveLength(0);
		// The run is logged allow-judged.
		const logRecords = await env.log.recent(50);
		expect(logRecords.some((record) => record.action === "allow-judged")).toBe(true);
	});

	it("a vague ask steers and records the fingerprint", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO],
		});
		const outcome = await evaluateLive(env.input());
		expect(outcome.action).toBe("steer");
		if (outcome.action !== "steer") return;
		expect(outcome.text).toContain("Your request didn't name these targets");
		expect(outcome.text).toContain("acme-media/torrents_remove");
		const state = await env.store.load(1 as never);
		expect(state.blocked.some((entry) => entry.status === "pending")).toBe(true);
		// The steer counts against the steer budget.
		expect(state.steers).toBe(1);
	});

	it("a tainted OLD run does not steer the first destructive call of a NEW run", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry(CLEAR_TEXT)],
			decisionResults: [CLEAR_OK],
		});
		// The previous run was tainted; this call is a NEW run (runStart
		// advanced). The run-boundary reset must run BEFORE the taint gate.
		await env.store.update(1 as never, (state) => {
			state.runStart = 1 as never;
			state.tainted = true;
			state.steers = 2;
		});
		const newRun: RunInfo = { ...env.run, runStart: 9 as never };
		const outcome = await evaluateLive(env.input({ run: newRun }));
		expect(outcome).toEqual({ action: "run" });
		const state = await env.store.load(1 as never);
		expect(state.tainted).toBeUndefined();
		expect(state.runStart).toBe(9);
	});

	it("the steer always mentions ask_user_question", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO],
		});
		const outcome = await evaluateLive(env.input());
		if (outcome.action !== "steer") throw new Error("expected a steer");
		expect(outcome.text).toContain("ask_user_question");
	});
});

describe("evaluateLive: approval on reply", () => {
	let env: LiveEnv | undefined;
	afterEach(async () => {
		await env?.fake.cleanup();
		env = undefined;
	});

	it("an approving person message after the steer releases", async () => {
		// First pass: vague ask → steer + blocked record.
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO, APPROVE_OK],
		});
		const first = await evaluateLive(env.input());
		expect(first.action).toBe("steer");
		const request = userEntry("tidy up my downloads");

		// The person replies approvingly; the retry's run window is anchored
		// at the reply (runInfo anchors at the NEWEST pi.user entry).
		const reply = userEntry("yes, those are the right torrents — remove them");
		const run2 = await runInfoFor(env, [request, reply]);
		const second = await evaluateLive(env.input({ run: run2 }));
		expect(second).toEqual({ action: "run" });
		const state = await env.store.load(1 as never);
		expect(state.blocked).toHaveLength(0);
		expect(state.released).toHaveLength(1);
		const logRecords = await env.log.recent(50);
		expect(
			logRecords.some(
				(record) => record.action === "release" && record.outcome === "approved",
			),
		).toBe(true);
	});

	it("one approving reply releases exactly one execution; an identical second call with no newer reply is held", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO, APPROVE_OK, CLEAR_NO],
		});
		expect((await evaluateLive(env.input())).action).toBe("steer");
		const request = userEntry("tidy up my downloads");

		// The person approves; the retry releases (the approval reply is consumed).
		const reply = userEntry("yes, remove those two");
		const run2 = await runInfoFor(env, [request, reply]);
		expect(await evaluateLive(env.input({ run: run2 }))).toEqual({ action: "run" });

		// An identical second call in the same run window, with the judge now
		// calling the ask UNCLEAR: the already-consumed reply must not release
		// it — the flow falls back to a fresh steer, and `released` still holds
		// exactly one entry.
		const third = await evaluateLive(env.input({ run: run2, call: callWith("c2") }));
		expect(third.action).toBe("steer");
		const state = await env.store.load(1 as never);
		expect(state.released).toHaveLength(1);
	});

	it("an approving ask_user_question answer in the same run releases", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO, APPROVE_OK],
		});
		expect((await evaluateLive(env.input())).action).toBe("steer");
		const request = userEntry("tidy up my downloads");

		// The agent asked the person via ask_user_question inside the same run;
		// its tool-result entry is the reply.
		const run2 = await runInfoFor(env, [
			request,
			toolResultEntry(
				"ask_user_question",
				"Q: May I remove torrents 7 and 9 with their data? A: Yes, go ahead",
			),
		]);
		const second = await evaluateLive(env.input({ run: run2 }));
		expect(second).toEqual({ action: "run" });
		const state = await env.store.load(1 as never);
		expect(state.blocked).toHaveLength(0);
		expect(state.released).toHaveLength(1);
	});

	it("a non-approving reply steers again", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO, APPROVE_NO],
		});
		expect((await evaluateLive(env.input())).action).toBe("steer");
		const request = userEntry("tidy up my downloads");

		const reply = userEntry("no wait, I only meant the completed ones");
		const run2 = await runInfoFor(env, [request, reply]);
		const second = await evaluateLive(env.input({ run: run2 }));
		if (second.action !== "steer") throw new Error("expected a steer");
		expect(second.text).toContain("doesn't approve acme-media/torrents_remove");
		// Still held.
		const state = await env.store.load(1 as never);
		expect(state.blocked).toHaveLength(1);
	});

	it("a retry with no reply asks the person", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("tidy up my downloads")],
			decisionResults: [CLEAR_NO],
		});
		expect((await evaluateLive(env.input())).action).toBe("steer");
		// Identical retry, same run, nothing new: the ignored steer escalates.
		const second = await evaluateLive(env.input({ call: callWith("c2") }));
		expect(second).toEqual({ action: "ask-person" });
	});
});

describe("evaluateLive: judge failures", () => {
	let env: LiveEnv | undefined;
	afterEach(async () => {
		await env?.fake.cleanup();
		env = undefined;
	});

	it("no_model → asks the person", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry(CLEAR_TEXT)],
			decisionResults: [{ ok: false, code: "no_model", error: "no decision model" }],
		});
		const outcome = await evaluateLive(env.input());
		expect(outcome).toEqual({ action: "ask-person" });
	});

	it("timeout → asks the person", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry(CLEAR_TEXT)],
			decisionResults: [{ ok: false, code: "timeout", error: "timed out" }],
		});
		const outcome = await evaluateLive(env.input());
		expect(outcome).toEqual({ action: "ask-person" });
	});
});

describe("bash-unknown: the irreversible judgment", () => {
	let env: LiveEnv | undefined;
	afterEach(async () => {
		await env?.fake.cleanup();
		env = undefined;
	});

	it("actionAskGate skip → allow without a request", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("deploy the site")],
			decisionResults: [],
		});
		const outcome = await evaluateLive(
			env.input({
				classification: { kind: "bash-unknown", command: "true" },
				call: callWith("c1", "bash"),
			}),
		);
		expect(outcome).toEqual({ action: "run" });
		expect(env.fake.decisionCalls).toHaveLength(0);
	});

	it("irreversible 0.95 → destructive (the live flow)", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry(CLEAR_TEXT)],
			decisionResults: [IRREVERSIBLE_YES, CLEAR_OK],
		});
		const outcome = await evaluateLive(
			env.input({
				classification: BASH_UNKNOWN,
				call: callWith("c1", "bash"),
			}),
		);
		// Irreversible → destructive → the clear ask passes → run.
		expect(outcome).toEqual({ action: "run" });
		expect(env.fake.decisionCalls).toHaveLength(2);
		const first = env.fake.decisionCalls[0]!.request as {
			questions: Record<string, { type: string }>;
		};
		expect(Object.keys(first.questions)).toEqual(["irreversible"]);
		const logRecords = await env.log.recent(50);
		expect(logRecords.some((record) => record.action === "allow-judged")).toBe(true);
	});

	it("0.6 → allow and logged", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("deploy the site")],
			decisionResults: [IRREVERSIBLE_MID],
		});
		const outcome = await evaluateLive(
			env.input({
				classification: BASH_UNKNOWN,
				call: callWith("c1", "bash"),
			}),
		);
		expect(outcome).toEqual({ action: "run" });
		expect(env.fake.decisionCalls).toHaveLength(1);
		const logRecords = await env.log.recent(50);
		expect(
			logRecords.some(
				(record) => record.action === "allow-judged" && record.scores?.irreversible === 0.6,
			),
		).toBe(true);
	});

	it('bash "make deploy" with no judge: allowed live, blocked + escalated in a job', async () => {
		// LIVE: no judge → allow (pi-warden's offline behaviour).
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("deploy the site")],
		});
		const liveOutcome = await evaluateLive(
			env.input({
				classification: BASH_UNKNOWN,
				call: callWith("c1", "bash"),
				judgeOff: true,
			}),
		);
		expect(liveOutcome).toEqual({ action: "run" });
		expect(env.fake.decisionCalls).toHaveLength(0);

		// JOB: no judge → classified destructive → the Task 11 job path
		// (block + escalation).
		const escalations = (await import("./fake-host.js")).createFakeEscalations();
		const jobFake = await createFakeHost({
			owner: "bob",
			activeRun: { jobId: "ext:acme:cleanup", owner: "bob" },
			entries: [],
			escalations,
		});
		try {
			const jobLog = new HoldLog(`${jobFake.root}/state/holds.jsonl`, () => new Date());
			const jobStore = new StateStore(`${jobFake.root}/state`);
			const jobRun = await runInfo(jobFake.host, 1 as never);
			const blocked = await routeOffline({
				host: jobFake.host,
				call: callWith("c1", "bash"),
				conversationId: 1 as never,
				// evaluateLive with no judge in a job classifies bash-unknown as
				// destructive; this test drives the resulting classification.
				classification: { kind: "destructive", reasons: ["unrecognized shell command: make deploy"] },
				presence: { kind: "job", jobId: "ext:acme:cleanup", owner: "bob" },
				run: jobRun,
				settings: defaultSettings(),
				store: jobStore,
				log: jobLog,
				context: liveContext(),
			});
			expect(blocked?.block).toContain("escalation esc-1");
			expect(escalations.items).toHaveLength(1);
			expect(escalations.items[0]!.status).toBe("open");
		} finally {
			await jobFake.cleanup();
		}
	});
});

/**
 * A run window through a REAL runInfo on a replacement entries list: the
 * fake host's entries are fixed at construction, so tests that need a
 * later run window build it structurally with the same helpers.
 */
async function runInfoFor(env: LiveEnv, entries: unknown[]): Promise<RunInfo> {
	const fake2 = await createFakeHost({ owner: "alice", entries });
	const run = await runInfo(fake2.host, 1 as never);
	await fake2.cleanup();
	return run;
}



/**
 * mcp-unknown: an MCP tool whose server declares no annotations is judged
 * for irreversibility (like bash-unknown) instead of presumed destructive.
 * A reversible call (a web search) runs with no hold and no clear-ask
 * question; only an irreversible verdict enters the destructive flow.
 */
describe("mcp-unknown: the irreversible judgment", () => {
	const SEARCH_CALL = {
		type: "toolCall",
		id: "s1",
		name: "acme-search/search_json",
		arguments: { query: "dryer stuck on welcome screen", count: 10 },
	} as ToolHookCall;
	const MCP_UNKNOWN: Classification = {
		kind: "mcp-unknown",
		reason: "MCP tool acme-search/search_json has no trustable annotation",
		mcp: { server: "acme-search", mcpName: "search_json" },
	};
	const IRREVERSIBLE_LOW = {
		ok: true,
		model: "acme/model-1",
		answers: { irreversible: { type: "noul", noul: 0.02 } },
		usage: { input_tokens: 10, output_tokens: 2 },
		elapsedMs: 5,
	};

	let env: LiveEnv | undefined;
	afterEach(async () => {
		await env?.fake.cleanup();
		env = undefined;
	});

	it("a reversible search runs live with one irreversible question and no hold", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("research why my dryer is stuck on the welcome screen")],
			decisionResults: [IRREVERSIBLE_LOW],
		});
		const blocked = await routeOffline(
			env.input({ classification: MCP_UNKNOWN, call: SEARCH_CALL }),
		);
		expect(blocked).toBeUndefined();
		expect(env.fake.decisionCalls).toHaveLength(1);
		const request = env.fake.decisionCalls[0]!.request as {
			state: { action: { tool: string; arguments: unknown } };
			questions: Record<string, unknown>;
		};
		expect(Object.keys(request.questions)).toEqual(["irreversible"]);
		expect(request.state.action.tool).toBe("acme-search/search_json");
		expect(request.state.action.arguments).toEqual(SEARCH_CALL.arguments);
		const state = await env.store.load(1 as never);
		expect(state.blocked).toHaveLength(0);
	});

	it("an irreversible verdict enters the destructive flow (clear ask)", async () => {
		env = await liveEnv({
			owner: "alice",
			entries: [userEntry("research the dryer")],
			decisionResults: [IRREVERSIBLE_YES, CLEAR_NO],
		});
		const outcome = await evaluateLive(
			env.input({ classification: MCP_UNKNOWN, call: SEARCH_CALL }),
		);
		expect(outcome).toMatchObject({ action: "steer" });
		expect(env.fake.decisionCalls).toHaveLength(2);
	});

	it("no judge live → runs (pi-warden's offline behaviour)", async () => {
		env = await liveEnv({ owner: "alice", entries: [userEntry("research the dryer")] });
		const blocked = await routeOffline(
			env.input({ classification: MCP_UNKNOWN, call: SEARCH_CALL, judgeOff: true }),
		);
		expect(blocked).toBeUndefined();
	});

	it("in a job: reversible runs, no judge fails closed into an escalation", async () => {
		const escalations = (await import("./fake-host.js")).createFakeEscalations();
		for (const [judged, expectRun] of [
			[true, true],
			[false, false],
		] as const) {
			const jobFake = await createFakeHost({
				owner: "bob",
				activeRun: { jobId: "ext:acme:research", owner: "bob" },
				entries: [],
				escalations,
				decisionResults: [IRREVERSIBLE_LOW],
			});
			try {
				const cooldown = new Cooldown();
				const result = await routeOffline({
					host: jobFake.host,
					call: SEARCH_CALL,
					conversationId: 1 as never,
					classification: MCP_UNKNOWN,
					presence: { kind: "job", jobId: "ext:acme:research", owner: "bob" },
					run: await runInfo(jobFake.host, 1 as never),
					settings: defaultSettings(),
					store: new StateStore(`${jobFake.root}/state`),
					log: new HoldLog(`${jobFake.root}/state/holds.jsonl`, () => new Date()),
					context: liveContext(),
					...(judged ? { judge: decisionsJudge(jobFake.host, defaultSettings(), cooldown) } : {}),
					cooldown,
				});
				if (expectRun) {
					expect(result).toBeUndefined();
					expect(escalations.items).toHaveLength(0);
				} else {
					expect(result?.block).toContain("escalation");
					expect(escalations.items).toHaveLength(1);
				}
			} finally {
				await jobFake.cleanup();
			}
		}
	});

	it("a curator review still blocks outright", async () => {
		env = await liveEnv({ owner: "alice", entries: [], decisionResults: [IRREVERSIBLE_LOW] });
		const blocked = await routeOffline(
			env.input({
				classification: MCP_UNKNOWN,
				call: SEARCH_CALL,
				presence: { kind: "internal" } as LiveInput["presence"],
			}),
		);
		expect(blocked?.block).toContain("curator");
		expect(env.fake.decisionCalls).toHaveLength(0);
	});
});
