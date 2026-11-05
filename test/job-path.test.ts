/**
 * Task 14 job-path tests: clearances + the per-target card check on the
 * job branch. A CLEARED destructive call runs autonomously only after a
 * per-target card check against the decision model; everything else
 * blocks + escalates (Task 11's job path).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

import type { Classification } from "../src/classify.js";
import type { Card } from "../src/cards.js";
import { CardStore } from "../src/cards.js";
import { runInfo } from "../src/context.js";
import { Cooldown } from "../src/judge.js";
import { HoldLog } from "../src/log.js";
import { routeOffline } from "../src/route.js";
import { defaultSettings, parseSettings } from "../src/settings.js";
import { StateStore } from "../src/state.js";
import {
	assistantEntry,
	createFakeEscalations,
	createFakeHost,
	resetEntryIds,
	toolResultEntry,
	userEntry,
} from "./fake-host.js";
import type { FakeEscalations, FakeHost } from "./fake-host.js";

const TOOL = "acme-media/torrents_remove";
const MCP_NAME = "torrents_remove";
const JOB = "ext:acme:cleanup";

const SKILL_BODY = [
	"# acme-cleanup",
	"",
	"Rule 1: remove only torrents the listing shows at 100% seeding.",
	"Rule 2: escalate for anything the listing does not cover.",
].join("\n");

const CARD: Card = {
	hash: createHash("sha256").update(SKILL_BODY, "utf8").digest("hex"),
	skill: "acme-cleanup",
	builtAt: "2026-11-05T00:00:00.000Z",
	model: "acme/utility-1",
	text: [
		"## torrents_remove",
		"",
		"**Allowed without asking when:** the listing shows the torrent at 100% seeding.",
		"**Evidence required first:** the torrents_list result naming the target.",
		"**Escalate instead when:** the listing does not name the target.",
	].join("\n"),
};

const DESTRUCTIVE: Classification = {
	kind: "destructive",
	reasons: [`MCP tool ${TOOL} is annotated destructive`],
	mcp: { server: "acme-media", mcpName: MCP_NAME },
};

function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

function callWith(id: string, args: Record<string, unknown> = { ids: [7, 9] }): ToolHookCall {
	return { type: "toolCall", id, name: TOOL, arguments: args } as ToolHookCall;
}

/** The ok decision result with every question answered at `score`. */
function okResult(scoreBy: (question: string) => number, questionNames: string[]) {
	return {
		ok: true,
		answers: Object.fromEntries(
			questionNames.map((name) => [name, { type: "noul", noul: scoreBy(name) }]),
		),
		usage: { input_tokens: 1, output_tokens: 1 },
		model: "acme/decision-1",
		elapsedMs: 1,
	};
}

interface Env {
	fake: FakeHost;
	escalations: FakeEscalations;
	log: HoldLog;
	store: StateStore;
	settings: ReturnType<typeof defaultSettings>;
	cooldown: Cooldown;
}

/**
 * A job presence over a run that saw the acme-cleanup skill (inline
 * build path) and one evidence result; the card store is seeded with
 * CARD so no inline build is needed.
 */
async function jobEnv(opts: {
	clearances?: { job: string; tools: string[] }[];
	decisionResults?: unknown[];
	entries?: unknown[];
	skillLocation?: string;
	seedCard?: boolean;
}): Promise<Env> {
	const escalations = createFakeEscalations(true);
	const skillTag =
		opts.skillLocation === undefined
			? `<skill name="acme-cleanup">`
			: `<skill name="acme-cleanup" location="${opts.skillLocation}">`;
	const entries = opts.entries ?? [
		userEntry("clean up done torrents"),
		userEntry(`${skillTag}\n${SKILL_BODY}\n</skill>`),
		toolResultEntry("acme-media/torrents_list", "7: done, seeding 100%\n9: done, seeding 100%"),
		assistantEntry(),
	];
	const fake = await createFakeHost({
		owner: "alice",
		metaJobId: JOB,
		activeRun: { jobId: JOB, owner: "alice" },
		entries,
		escalations,
		decisionResults: opts.decisionResults ?? [],
	});
	if (opts.seedCard !== false) {
		await new CardStore(`${fake.root}/data`).put(CARD);
	}
	const log = new HoldLog(`${fake.root}/state/holds.jsonl`, () => new Date());
	const store = new StateStore(`${fake.root}/state`);
	const settings = parseSettings(
		{
			clearances: opts.clearances ?? [{ job: JOB, tools: [TOOL] }],
		},
		() => {},
	);
	return { fake, escalations, log, store, settings, cooldown: new Cooldown() };
}

async function route(
	env: Env,
	call: ToolHookCall,
	classification: Classification = DESTRUCTIVE,
	opts: { judge?: boolean } = {},
) {
	const run = await runInfo(env.fake.host, 1 as never);
	const judge =
		opts.judge === false
			? undefined
			: {
					evaluate: async (request: unknown) => {
						// Drive through the REAL decisionsJudge so the cooldown and
						// the ok:false → throw conversion are under test.
						const { decisionsJudge } = await import("../src/judge.js");
						const j = decisionsJudge(env.fake.host, env.settings, env.cooldown);
						if (j === undefined) throw new Error("not_configured: no decision judge");
						return j.evaluate(request as never);
					},
				};
	return routeOffline({
		host: env.fake.host,
		call,
		conversationId: 1 as never,
		classification,
		presence: { kind: "job", jobId: JOB, owner: "alice" },
		run,
		settings: env.settings,
		store: env.store,
		log: env.log,
		context: liveContext(),
		...(judge === undefined ? {} : { judge: judge as never }),
		cooldown: env.cooldown,
	});
}

/** The hold-log records of one env, newest last. */
async function logRecords(env: Env): Promise<Record<string, unknown>[]> {
	const text = await readFile(`${env.fake.root}/state/holds.jsonl`, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const QUESTIONS_2 = ["t0_meets", "t0_escalate", "t1_meets", "t1_escalate"];

describe("job path: clearances + card check", () => {
	let env: Env;
	afterEach(async () => {
		await env.fake.cleanup();
	});

	it("not cleared → block + escalate (no decision request)", async () => {
		env = await jobEnv({ clearances: [] });
		const result = await route(env, callWith("c1"));
		expect(result?.block).toContain("Not cleared for this job");
		expect(env.escalations.items).toHaveLength(1);
		expect(env.fake.decisionCalls).toHaveLength(0);
	});

	it("cleared + passing card check → runs and logs allow-judged with the scores", async () => {
		env = await jobEnv({
			decisionResults: [okResult((q) => (q.endsWith("_escalate") ? 0.1 : 0.95), QUESTIONS_2)],
		});
		const result = await route(env, callWith("c1"));
		expect(result).toBeUndefined();
		expect(env.fake.decisionCalls).toHaveLength(1);
		const request = env.fake.decisionCalls[0]!.request as {
			questions: Record<string, unknown>;
		};
		expect(Object.keys(request.questions)).toEqual(QUESTIONS_2);
		const records = await logRecords(env);
		const allow = records.find((record) => record.action === "allow-judged");
		expect(allow).toBeDefined();
		expect(allow!.scores).toEqual({
			t0_meets: 0.95,
			t0_escalate: 0.1,
			t1_meets: 0.95,
			t1_escalate: 0.1,
		});
		// Passing card check runs without an escalation or a grant.
		expect(env.escalations.items).toHaveLength(0);
	});

	it("cleared + one failing target of 3 → block naming it + escalate", async () => {
		const questions = [
			"t0_meets",
			"t0_escalate",
			"t1_meets",
			"t1_escalate",
			"t2_meets",
			"t2_escalate",
		];
		env = await jobEnv({
			decisionResults: [
				okResult((q) => {
					if (q === "t1_meets") return 0.1;
					if (q.endsWith("_escalate")) return 0.2;
					return 0.9;
				}, questions),
			],
		});
		const result = await route(env, callWith("c1", { ids: [7, 8, 9] }));
		expect(result?.block).toContain("8");
		expect(result?.block).toContain("t1_meets");
		expect(env.escalations.items).toHaveLength(1);
	});

	it("40 targets → split steer + escalate, no decision request", async () => {
		env = await jobEnv({});
		const ids = Array.from({ length: 40 }, (_, i) => i + 1);
		const result = await route(env, callWith("c1", { ids }));
		expect(result?.block).toContain("too many targets");
		expect(result?.block).toContain("split this into calls of at most 16 targets");
		expect(env.escalations.items).toHaveLength(1);
		expect(env.fake.decisionCalls).toHaveLength(0);
	});

	it("job + bash-unknown + no decision model → block + escalate", async () => {
		env = await jobEnv({ clearances: [], decisionResults: [] });
		const classification: Classification = {
			kind: "bash-unknown",
			command: "ffmpeg -i https://example.invalid/in.mkv out.mp4",
		};
		const bashCall: ToolHookCall = {
			type: "toolCall",
			id: "c1",
			name: "bash",
			arguments: { command: "ffmpeg -i https://example.invalid/in.mkv out.mp4" },
		} as ToolHookCall;
		const result = await route(env, bashCall, classification, { judge: false });
		expect(result?.block).toContain("Not cleared for this job");
		expect(env.escalations.items).toHaveLength(1);
	});

	it("cleared + no_model / not_configured / cooldown → block + escalate, never runs", async () => {
		for (const code of ["no_model", "not_configured"] as const) {
			const local = await jobEnv({
				decisionResults: [{ ok: false, code, error: "the decision model failed" }],
			});
			const result = await route(local, callWith("c1"));
			expect(result?.block).toContain("no decision model available");
			expect(local.escalations.items).toHaveLength(1);
			await local.fake.cleanup();
		}
		// Cooling down: the judge is undefined on the route input.
		env = await jobEnv({});
		env.cooldown.failed();
		env.cooldown.failed();
		env.cooldown.failed();
		expect(env.cooldown.active).toBe(true);
		const result = await route(env, callWith("c1"), DESTRUCTIVE, { judge: false });
		expect(result?.block).toContain("no decision model available");
		expect(env.escalations.items).toHaveLength(1);
	});

	it("cleared + bad_answer → block + escalate", async () => {
		env = await jobEnv({
			decisionResults: [{ ok: false, code: "bad_answer", error: "the provider lied" }],
		});
		const result = await route(env, callWith("c1"));
		expect(result?.block).toContain("no decision model available");
		expect(env.escalations.items).toHaveLength(1);
	});

	it("cleared + no card covering the tool → block + escalate", async () => {
		env = await jobEnv({ seedCard: false });
		// The inline build uses the fake models.complete, whose default
		// answer "card" names no tool — so no governing card.
		const result = await route(env, callWith("c1"));
		expect(result?.block).toContain(`no skill card covers ${MCP_NAME}`);
		expect(env.escalations.items).toHaveLength(1);
	});

	it("a learned-root skill's card is accepted as a source", async () => {
		env = await jobEnv({
			skillLocation: "https://example.invalid/learned/acme-cleanup/SKILL.md",
			decisionResults: [okResult((q) => (q.endsWith("_escalate") ? 0.1 : 0.95), QUESTIONS_2)],
		});
		const result = await route(env, callWith("c1"));
		expect(result).toBeUndefined();
		expect(env.fake.decisionCalls).toHaveLength(1);
	});

	it("an uncleared job with a perfect card still escalates (clearance never comes from a skill)", async () => {
		env = await jobEnv({
			clearances: [{ job: "ext:acme:other-job", tools: [TOOL] }],
			decisionResults: [okResult((q) => (q.endsWith("_escalate") ? 0.1 : 0.95), QUESTIONS_2)],
		});
		const result = await route(env, callWith("c1"));
		expect(result?.block).toContain("Not cleared for this job");
		expect(env.escalations.items).toHaveLength(1);
		expect(env.fake.decisionCalls).toHaveLength(0);
	});

	it("evidence: only this run's results mentioning a target, newest first, redacted, within budget", async () => {
		resetEntryIds();
		const entries = [
			userEntry("clean up done torrents"),
			userEntry(`<skill name="acme-cleanup">\n${SKILL_BODY}\n</skill>`),
			// Mentioning no target: excluded.
			toolResultEntry("acme-media/torrents_list", "nothing relevant here", "list-0"),
			// Oldest first; evidence comes back newest first.
			toolResultEntry("acme-media/torrents_list", "7: seeding 100% api_key=ak_live_4f3c9b2e7a1d", "list-1"),
			toolResultEntry("acme-media/torrents_list", "9: seeding 100%", "list-2"),
			assistantEntry(),
		];
		env = await jobEnv({
			entries,
			decisionResults: [okResult((q) => (q.endsWith("_escalate") ? 0.1 : 0.95), QUESTIONS_2)],
		});
		const result = await route(env, callWith("c1"));
		expect(result).toBeUndefined();
		const request = env.fake.decisionCalls[0]!.request as {
			state: { evidence: string[] };
		};
		expect(request.state.evidence).toHaveLength(2);
		// Newest first.
		expect(request.state.evidence[0]).toContain("9: seeding 100%");
		expect(request.state.evidence[1]).toContain("7: seeding 100%");
		// Secrets masked.
		expect(JSON.stringify(request.state.evidence)).not.toContain("ak_live_4f3c9b2e7a1d");
		expect(JSON.stringify(request.state.evidence)).toContain("[redacted]");
	});
});
