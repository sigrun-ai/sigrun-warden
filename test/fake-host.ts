import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SigrunHost } from "@sigrun/sigrun/extension";

export interface FakePublishedHooks {
	readonly calls: readonly { name: string; payload: unknown; opts: unknown }[];
	/** Queue of results `call` returns in order; the last one repeats. */
	results: unknown[];
}

export interface FakeDecisions {
	readonly evaluates: readonly { request: unknown; opts: unknown }[];
	readonly lists: number;
}

export interface FakeHost {
	readonly host: SigrunHost;
	readonly root: string;
	readonly publishedHooks: FakePublishedHooks;
	readonly decisions: FakeDecisions;
	cleanup(): Promise<void>;
}

/**
 * A structural SigrunHost double for the warden tests. Store paths point
 * at a real temp directory; `decisions.evaluate`/`list` and
 * `publishedHooks.call` record their calls and return configurable
 * results. Every other host member throws so a test gap fails loudly.
 */
export async function createFakeHost(): Promise<FakeHost> {
	const root = await mkdtemp(join(tmpdir(), "sigrun-warden-fake-host-"));
	const hookCalls: { name: string; payload: unknown; opts: unknown }[] = [];
	const hookResults: unknown[] = [];
	const evaluates: { request: unknown; opts: unknown }[] = [];
	let lists = 0;
	const notUsed = (): never => {
		throw new Error("not used in warden tests");
	};

	const host = {
		stores: {
			user: notUsed,
			secrets: { get: notUsed, set: notUsed },
			settings: { get: async () => ({}), set: notUsed },
			paths: {
				data: join(root, "data"),
				state: join(root, "state"),
				cache: join(root, "cache"),
			},
		},
		decisions: {
			evaluate: async (request: unknown, opts: unknown) => {
				evaluates.push({ request, opts });
				throw new Error("not used in warden tests");
			},
			list: async () => {
				lists += 1;
				return [];
			},
		},
		publishedHooks: {
			get: () => undefined,
			call: async (name: string, payload: unknown, opts: unknown) => {
				hookCalls.push({ name, payload, opts });
				return hookResults.length > 1
					? hookResults.shift()
					: (hookResults[0] ?? { status: "absent" });
			},
		},
	} as unknown as SigrunHost;

	return {
		host,
		root,
		publishedHooks: {
			get calls() {
				return hookCalls;
			},
			results: hookResults,
		},
		decisions: {
			evaluates,
			get lists() {
				return lists;
			},
		},
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}
