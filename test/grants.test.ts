/**
 * Task 11 job-grant tests: block + escalate, one-shot grants, the
 * per-grant in-flight reservation, and the escalation-absent fallback.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

import type { Classification } from "../src/classify.js";
import { runInfo } from "../src/context.js";
import { HoldLog } from "../src/log.js";
import { resetNoProviderWarning } from "../src/escalate.js";
import { resolveReservedGrant, routeOffline } from "../src/route.js";
import { defaultSettings } from "../src/settings.js";
import { grantKey, StateStore } from "../src/state.js";
import { createFakeEscalations, createFakeHost, userEntry, assistantEntry } from "./fake-host.js";
import type { FakeEscalations, FakeHost } from "./fake-host.js";

const TOOL = "acme-media/torrents_remove";
const ARGS = { ids: [7, 9] };
const JOB = "ext:acme:cleanup";
const KEY = grantKey(TOOL, ARGS);

function callWith(id: string): ToolHookCall {
	return { type: "toolCall", id, name: TOOL, arguments: ARGS } as ToolHookCall;
}

const DESTRUCTIVE: Classification = {
	kind: "destructive",
	reasons: [`MCP tool ${TOOL} is annotated destructive`],
	mcp: { server: "acme-media", mcpName: "torrents_remove" },
};

function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

interface Env {
	fake: FakeHost;
	escalations: FakeEscalations;
	log: HoldLog;
	store: StateStore;
	/** The transcript, grown between job fires (a new fire = a new run). */
	entries: unknown[];
}

async function jobEnv(opts: { escalationsAvailable?: boolean } = {}): Promise<Env> {
	const escalations = createFakeEscalations(opts.escalationsAvailable ?? true);
	const entries: unknown[] = [userEntry("clean up done torrents"), assistantEntry()];
	const fake = await createFakeHost({
		owner: "alice",
		metaJobId: JOB,
		activeRun: { jobId: JOB, owner: "alice" },
		entries,
		escalations,
	});
	// The fake host serves the LIVE array so a test can append a user
	// entry to model the next job fire (a new run boundary).
	const log = new HoldLog(`${fake.root}/state/holds.jsonl`, () => new Date());
	const store = new StateStore(`${fake.root}/state`);
	return { fake, escalations, log, store, entries };
}

async function route(env: Env, call: ToolHookCall) {
	const run = await runInfo(env.fake.host, 1 as never);
	return routeOffline({
		host: env.fake.host,
		call,
		conversationId: 1 as never,
		classification: DESTRUCTIVE,
		presence: { kind: "job", jobId: JOB, owner: "alice" },
		run,
		settings: defaultSettings(),
		store: env.store,
		log: env.log,
		context: liveContext(),
	});
}

/** Model the next job fire: a fresh user input = a new run boundary. */
function nextFire(env: Env): void {
	env.entries.push(userEntry("clean up done torrents"), assistantEntry());
}

describe("job presence: block + escalate", () => {
	let env: Env;
	afterEach(async () => {
		await env.fake.cleanup();
	});

	it("job destructive raises once per grant key and blocks", async () => {
		env = await jobEnv();
		const result = await route(env, callWith("c1"));
		expect(result?.block).toBe(
			"Not cleared for this job without a person's approval; raised escalation esc-1.",
		);
		expect(env.escalations.items).toHaveLength(1);
		const item = env.escalations.items[0]!;
		expect(item.key).toBe(KEY);
		expect(item.status).toBe("open");
		// The raise payload: onAnswer next-run, jobId, approve/decline options.
		const raiseCall = env.fake.publishedHooks.calls.find(
			(entry) => entry.name === "escalation.raise",
		);
		const payload = raiseCall?.payload as Record<string, unknown>;
		expect(payload.onAnswer).toBe("next-run");
		expect(payload.jobId).toBe(JOB);
		expect((payload.options as { id: string }[]).map((o) => o.id)).toEqual([
			"approve",
			"decline",
		]);
		expect(payload.body as string).toContain(TOOL);
		expect(payload.body as string).toContain('"ids"');
		expect(payload.body as string).toContain("annotated destructive");
	});

	it("an identical call in the same run reuses the item (created:false)", async () => {
		env = await jobEnv();
		const first = await route(env, callWith("c1"));
		const second = await route(env, callWith("c2"));
		expect(first?.block).toContain("raised escalation esc-1");
		expect(second?.block).toContain("raised escalation esc-1");
		expect(env.escalations.items).toHaveLength(1);
		const raises = env.fake.publishedHooks.calls.filter(
			(entry) => entry.name === "escalation.raise",
		);
		expect(raises).toHaveLength(2); // the hook is called, the store dedups
		expect(env.escalations.items[0]!.created).toBe(true);
	});
});

describe("job presence: one-shot grants", () => {
	let env: Env;
	afterEach(async () => {
		await env.fake.cleanup();
	});

	it("an approved grant runs once: take -> claimed, afterTool resolves done, a later identical call raises again", async () => {
		env = await jobEnv();
		// Raise first, then the person approves.
		await route(env, callWith("c1"));
		env.escalations.answer(KEY, "approve");

		const allowed = await route(env, callWith("c2"));
		expect(allowed).toBeUndefined();
		const item = env.escalations.items[0]!;
		expect(item.status).toBe("claimed");

		// The granted call runs; afterTool resolves the item done.
		await resolveReservedGrant({
			host: env.fake.host,
			call: callWith("c2"),
			conversationId: 1 as never,
			result: { isError: false },
			store: env.store,
		});
		expect(item.status).toBe("resolved");
		expect(item.resolveOutcome).toBe("done");
		expect(item.resolveNote).toBe("warden: executed");

		// A later identical call must raise again (the grant was one-shot).
		const again = await route(env, callWith("c3"));
		expect(again?.block).toContain("Not cleared for this job");
	});

	it("a failed grant execution resolves the item failed", async () => {
		env = await jobEnv();
		await route(env, callWith("c1"));
		env.escalations.answer(KEY, "approve");
		await route(env, callWith("c2"));
		await resolveReservedGrant({
			host: env.fake.host,
			call: callWith("c2"),
			conversationId: 1 as never,
			result: { isError: true },
			store: env.store,
		});
		expect(env.escalations.items[0]!.resolveOutcome).toBe("failed");
		expect(env.escalations.items[0]!.resolveNote).toBe("warden: the call failed");
	});

	it("two identical calls in flight at once: exactly one is allowed", async () => {
		env = await jobEnv();
		await route(env, callWith("c1")); // raise
		env.escalations.answer(KEY, "approve");

		const [a, b] = await Promise.all([route(env, callWith("c2")), route(env, callWith("c3"))]);
		const allowed = [a, b].filter((result) => result === undefined);
		const blocked = [a, b].filter((result) => result !== undefined);
		expect(allowed).toHaveLength(1);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.block).toBe(
			"an identical call is already running under this approval",
		);
	});

	it("a restart after take but before execution still runs it once", async () => {
		env = await jobEnv();
		await route(env, callWith("c1"));
		env.escalations.answer(KEY, "approve");
		// The granted call takes + reserves but the process dies before the
		// call runs. Restart: a NEW run (a fresh user entry) in the SAME
		// conversation; the stale reservation is dropped, take re-claims the
		// still-answered item, the call runs once.
		await route(env, callWith("c2"));
		// Simulate the restart by re-reading state through a fresh store.
		const freshStore = new StateStore(`${env.fake.root}/state`);
		env.store = freshStore;
		env.escalations.items[0]!.status = "answered"; // claim lost with the process
		const rerun = await route(env, callWith("c2"));
		expect(rerun).toBeUndefined();
		await resolveReservedGrant({
			host: env.fake.host,
			call: callWith("c2"),
			conversationId: 1 as never,
			result: {},
			store: env.store,
		});
		expect(env.escalations.items[0]!.resolveOutcome).toBe("done");
	});

	it("a crash before the take leaves an empty slot: a same-callId re-entry takes again (never runs on a placeholder)", async () => {
		env = await jobEnv();
		await route(env, callWith("c1")); // raise
		env.escalations.answer(KEY, "approve");
		const item = env.escalations.items[0]!;

		// The crash: the placeholder slot landed in the store but the
		// process died before takeGrant ran (escalationId still "").
		await env.store.update(1 as never, (state) => {
			state.reservations.push({ grantKey: KEY, callId: "c2", escalationId: "" });
		});

		// A re-entry with the SAME callId must NOT run on the placeholder:
		// it goes through decide/take again, claims the real grant, runs.
		const rerun = await route(env, callWith("c2"));
		expect(rerun).toBeUndefined();
		expect(item.status).toBe("claimed"); // a REAL take happened
		const reservation = (await env.store.load(1 as never)).reservations.find(
			(entry) => entry.grantKey === KEY,
		);
		expect(reservation?.escalationId).toBe(item.id);
	});

	it("a crash before the take with NO grant: the re-entry raises and blocks (never runs on a placeholder)", async () => {
		env = await jobEnv();
		await env.store.update(1 as never, (state) => {
			state.reservations.push({ grantKey: KEY, callId: "c2", escalationId: "" });
		});
		const rerun = await route(env, callWith("c2"));
		expect(rerun?.block).toContain("Not cleared for this job");
		expect(env.escalations.items).toHaveLength(1); // it raised, not ran
	});

	it("a throwing take clears the placeholder slot (the key is not wedged as contended)", async () => {
		env = await jobEnv();
		const original = env.fake.host.publishedHooks.call;
		let thrown = false;
		env.fake.host.publishedHooks.call = (async (
			name: string,
			payload: unknown,
			opts: { user?: string; conversationId?: never; abortSignal?: AbortSignal } | undefined,
		) => {
			if (name === "escalation.take" && !thrown) {
				thrown = true;
				throw new Error("inbox down");
			}
			return original(name, payload, opts);
		}) as typeof original;

		await expect(route(env, callWith("c1"))).rejects.toThrow("inbox down");
		// The placeholder slot is gone: the key is free, not wedged.
		expect((await env.store.load(1 as never)).reservations).toHaveLength(0);
		// A retry proceeds through the normal decide path (raise + block).
		const retry = await route(env, callWith("c2"));
		expect(retry?.block).toContain("raised escalation esc-1");
	});

	it("take -> another hook blocks the call -> run settles -> the item is reopened, not consumed", async () => {
		env = await jobEnv();
		await route(env, callWith("c1"));
		env.escalations.answer(KEY, "approve");
		const allowed = await route(env, callWith("c2"));
		expect(allowed).toBeUndefined();
		const item = env.escalations.items[0]!;
		expect(item.status).toBe("claimed");

		// The other hook's block means this call never executes; afterTool
		// is never invoked for it. The run settles: escalations' sweep
		// reopens the claimed item.
		const reopened = env.escalations.runEndSweep(1);
		expect(reopened).toHaveLength(1);
		expect(item.status).toBe("answered");
		expect(item.reopenNote).toBe("run ended without resolving the escalation");
		// The NEXT job fire (a new run) drops the stale reservation and
		// re-takes the reopened item: it claims and runs.
		nextFire(env);
		const again = await route(env, callWith("c3"));
		expect(again).toBeUndefined(); // re-take claims the answered item
	});

	it("a take answered decline is not a grant (blocked + stays raised)", async () => {
		env = await jobEnv();
		await route(env, callWith("c1"));
		env.escalations.answer(KEY, "decline");
		const result = await route(env, callWith("c2"));
		expect(result?.block).toContain("Not cleared for this job");
		expect(env.escalations.items[0]!.status).toBe("claimed"); // take claimed it
		expect(env.escalations.items[0]!.option).toBe("decline");
	});
});

describe("job presence: no escalation provider", () => {
	let env: Env;
	afterEach(async () => {
		await env.fake.cleanup();
	});

	it("falls back to a notice to the job owner keyed by the grant key", async () => {
		resetNoProviderWarning();
		env = await jobEnv({ escalationsAvailable: false });
		const result = await route(env, callWith("c1"));
		expect(result?.block).toContain("Not cleared for this job");
		expect(env.fake.notices.posted).toHaveLength(1);
		const notice = env.fake.notices.posted[0]!;
		expect(notice.user).toBe("alice");
		expect(notice.key).toBe(KEY);
		expect(notice.title).toBe(`Held: ${TOOL}`);
		expect(notice.tone).toBe("warn");
	});
});
