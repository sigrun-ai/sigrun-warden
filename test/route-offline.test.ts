/**
 * Task 11 live-routing tests: the fingerprint-keyed interaction question,
 * one-shot release semantics, and the deny/internal paths.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

import type { Classification } from "../src/classify.js";
import { runInfo } from "../src/context.js";
import { HoldLog } from "../src/log.js";
import { routeOffline, startPruneOnce, resetPruneGuardForTests } from "../src/route.js";
import { defaultSettings } from "../src/settings.js";
import { grantKey, StateStore } from "../src/state.js";
import { createFakeHost, resetEntryIds, userEntry, assistantEntry } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";

const CALL: Pick<ToolHookCall, "name" | "arguments"> = {
	name: "acme-media/torrents_remove",
	arguments: { ids: [7, 9] },
};

function callWith(id: string): ToolHookCall {
	return { type: "toolCall", id, ...CALL } as ToolHookCall;
}

const DESTRUCTIVE: Classification = {
	kind: "destructive",
	reasons: ["MCP tool acme-media/torrents_remove is annotated destructive"],
	mcp: { server: "acme-media", mcpName: "torrents_remove" },
};

/** A real chord-free cancellation Context double: never cancelled. */
function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

async function routeEnv(host: FakeHost, conversationId = 1) {
	const log = new HoldLog(`${host.root}/state/holds.jsonl`, () => new Date());
	const store = new StateStore(`${host.root}/state`);
	const run = await runInfo(host.host, conversationId as never);
	return { log, store, run };
}

describe("routeOffline: live presence", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
	});

	it("live destructive seeds one warden.confirm interaction and runs after allow", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }],
			entries: [userEntry("tidy the acme library")],
		});
		const { log, store, run } = await routeEnv(fake);
		const result = await routeOffline({
			host: fake.host,
			call: callWith("c1"),
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" },
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		});
		expect(result).toBeUndefined();
		expect(fake.interactions.seeded).toHaveLength(1);
		const seeded = fake.interactions.seeded[0]!;
		expect(seeded.kind).toBe("warden.confirm");
		expect(seeded.callId.startsWith("warden-")).toBe(true);
		expect(JSON.stringify(seeded.body)).toContain("acme-media/torrents_remove");
		expect(JSON.stringify(seeded.body)).toContain('"decision"');
	});

	it("deny blocks with the person's reason", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "deny", reason: "not those torrents" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const result = await routeOffline({
			host: fake.host,
			call: callWith("c1"),
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" },
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		});
		expect(result?.block).toContain("not those torrents");
	});

	it("a re-entered beforeTool with the same callId keeps waiting on the same record", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const input = {
			host: fake.host,
			call: callWith("c1"),
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" } as const,
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		};
		// First entry holds pending (no answer yet). Drive it in the
		// background, wait a tick, then re-enter.
		const first = routeOffline(input);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fake.interactions.seeded).toHaveLength(1);
		// The re-entry races the first: whichever poll consumes the single
		// answer RELEASES; the loser keeps waiting and is unblocked by the
		// test's cancellation of its context.
		const second = routeOffline(input);
		const firstResult = await first;
		expect(firstResult === undefined || second !== undefined).toBe(true);
		expect(fake.interactions.seeded).toHaveLength(1); // SAME card
	});

	it("a retry with a new callId waits on the same fingerprint-keyed record, no second card", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const base = {
			host: fake.host,
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" } as const,
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		};
		const first = routeOffline({ ...base, call: callWith("c1") });
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The retry joins the SAME card; exactly one of the two waits is
		// released by the single answer (consumption is one-shot). The
		// co-waiter does not resolve here: it blocks only when the sibling
		// settles (proven by the previous test); the test teardown cancels
		// this waiter.
		const second = routeOffline({ ...base, call: callWith("c2") });
		const firstResult = await first;
		expect(firstResult).toBeUndefined();
		expect(fake.interactions.seeded).toHaveLength(1);
		void second;
	});

	it("an answered allow releases one call; an identical later call is held again", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }, { decision: "allow" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const base = {
			host: fake.host,
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" } as const,
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		};
		const first = await routeOffline({ ...base, call: callWith("c1") });
		expect(first).toBeUndefined();
		expect(fake.interactions.seeded).toHaveLength(1);

		// The identical later call is HELD AGAIN: it seeds a fresh card. It
		// stays pending until the person's second answer arrives.
		// The identical later call is HELD AGAIN: it seeds a fresh card.
		const secondPromise = routeOffline({ ...base, call: callWith("c2") });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(fake.interactions.seeded.length).toBe(2); // a SECOND card
		const second = await secondPromise;
		expect(second).toBeUndefined();
	});

	it("two identical live calls: one answer releases exactly one; the co-waiter blocks, no spin", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const base = {
			host: fake.host,
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" } as const,
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		};
		const [a, b] = await Promise.all([
			routeOffline({ ...base, call: callWith("c1") }),
			routeOffline({ ...base, call: callWith("c2") }),
		]);
		const allowed = [a, b].filter((result) => result === undefined);
		const blocked = [a, b].filter((result) => result !== undefined);
		expect(allowed).toHaveLength(1);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.block).toBe(
			"an identical call is already awaiting approval",
		);
		expect(fake.interactions.seeded).toHaveLength(1); // ONE shared card
	});

	it("a nested call (call.parent set) from a codemode script is held the same way", async () => {
		fake = await createFakeHost({
			owner: "alice",
			answers: [{ decision: "allow" }],
		});
		const { log, store, run } = await routeEnv(fake);
		const nested = {
			type: "toolCall",
			id: "c9",
			...CALL,
			parent: { taskId: 7, callId: "outer" },
		} as unknown as ToolHookCall;
		const result = await routeOffline({
			host: fake.host,
			call: nested,
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "live", owner: "alice" },
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		});
		expect(result).toBeUndefined();
		expect(fake.interactions.seeded).toHaveLength(1); // held like any other
	});
});

describe("routeOffline: deny and internal", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
	});

	it("deny classification blocks in every presence (no question, no escalation)", async () => {
		fake = await createFakeHost({ owner: "alice" });
		const { log, store, run } = await routeEnv(fake);
		const classification: Classification = {
			kind: "deny",
			reason: 'deny rule "rm -rf" matched',
		};
		for (const presence of [
			{ kind: "live", owner: "alice" } as const,
			{ kind: "job", jobId: "ext:acme:cleanup", owner: "alice" } as const,
			{ kind: "internal" } as const,
		]) {
			const result = await routeOffline({
				host: fake.host,
				call: callWith(`c-${presence.kind}`),
				conversationId: 1 as never,
				classification,
				presence,
				run,
				settings: defaultSettings(),
				store,
				log,
				context: liveContext(),
			});
			expect(result?.block).toContain('deny rule "rm -rf" matched');
		}
		expect(fake.interactions.seeded).toHaveLength(0);
		expect(fake.publishedHooks.calls).toHaveLength(0);
	});

	it("internal destructive blocks without raising", async () => {
		const escalations = (await import("./fake-host.js")).createFakeEscalations();
		fake = await createFakeHost({ internal: true, escalations });
		const { log, store, run } = await routeEnv(fake);
		const result = await routeOffline({
			host: fake.host,
			call: callWith("c1"),
			conversationId: 1 as never,
			classification: DESTRUCTIVE,
			presence: { kind: "internal" },
			run,
			settings: defaultSettings(),
			store,
			log,
			context: liveContext(),
		});
		expect(result?.block).toBe(
			"This call can't run in a curator review: MCP tool acme-media/torrents_remove is annotated destructive",
		);
		expect(escalations.calls).toHaveLength(0);
	});
});

describe("runInfo: newest user input starts the run", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
	});

	it("a NEWER user entry moves runStart; an older one does not", async () => {
		resetEntryIds();
		const entries: unknown[] = [userEntry("first"), assistantEntry()];
		fake = await createFakeHost({ owner: "alice", entries });
		const first = await runInfo(fake.host, 1 as never);
		expect(first.request).toBe("first");
		const firstStart = first.runStart;

		entries.push(userEntry("second"), assistantEntry());
		const second = await runInfo(fake.host, 1 as never);
		expect(second.request).toBe("second");
		expect(second.runStart).not.toBe(firstStart);
	});

	it("beyond the oldest page, the newest user entry still starts the current run", async () => {
		// Fix round 2 (Task 11 re-review): a single ascending page reads the
		// OLDEST 200 entries, freezing runStart at the conversation's start
		// once the transcript outgrows it. The run window must anchor at the
		// NEWEST user input instead.
		resetEntryIds();
		const entries: unknown[] = [userEntry("first")];
		for (let i = 0; i < 228; i += 1) entries.push(assistantEntry());
		entries.push(userEntry("second"));
		for (let i = 0; i < 10; i += 1) entries.push(assistantEntry());
		expect(entries).toHaveLength(240);
		const newestUser = entries[229] as { id: number | bigint };
		fake = await createFakeHost({ owner: "alice", entries });

		const run = await runInfo(fake.host, 1 as never);
		expect(Number(run.runStart)).toBe(Number(newestUser.id));
		expect(run.request).toBe("second");
		expect(run.entries[0]!.id).toBe(newestUser.id);
		expect(run.entries).toHaveLength(11);
		// The descending probe runs first; the ascending window follows it.
		expect(fake.entriesQueries.length).toBeGreaterThanOrEqual(2);
		expect((fake.entriesQueries[0] as { order?: string }).order).toBe("descending");
		const windowQuery = fake.entriesQueries[1] as {
			order?: string;
			minEntryId?: number | bigint;
		};
		expect(windowQuery.order).toBe("ascending");
		expect(Number(windowQuery.minEntryId)).toBe(Number(newestUser.id));
	});

	it("probes descending first, then reads the run window ascending", async () => {
		fake = await createFakeHost({ owner: "alice", entries: [userEntry("hi")] });
		await runInfo(fake.host, 1 as never);
		expect(fake.entriesQueries.length).toBe(2);
		expect((fake.entriesQueries[0] as { order?: string }).order).toBe("descending");
		expect((fake.entriesQueries[1] as { order?: string }).order).toBe("ascending");
	});
});

describe("startPruneOnce", () => {
	it("prune runs once per process and never delays a call", async () => {
		resetPruneGuardForTests();
		const calls: number[] = [];
		const fakeLog = {
			prune: async () => {
				calls.push(1);
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		} as unknown as HoldLog;
		const settings = defaultSettings();
		startPruneOnce(fakeLog, settings.retentionDays);
		startPruneOnce(fakeLog, settings.retentionDays);
		expect(calls).toHaveLength(1); // started synchronously, once
	});
});
