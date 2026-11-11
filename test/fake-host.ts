import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type {
	DeclaredSettings,
	SettingsDeclaration,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { InteractionRecord } from "@sigrun/shared/interactions";

/** A queued interaction answer the fake poll delivers on seed. */
export interface FakeAnswer {
	readonly decision: "allow" | "deny";
	readonly reason?: string;
}

export interface FakeEscalationItem {
	id: string;
	key: string;
	namespace: string;
	status: "open" | "answered" | "claimed" | "resolved";
	option?: string;
	claimConversationId?: number;
	resolveOutcome?: "done" | "failed";
	resolveNote?: string;
	reopenNote?: string;
	created: boolean;
}

export interface FakeEscalations {
	readonly items: FakeEscalationItem[];
	readonly calls: readonly { name: string; payload: unknown }[];
	/** Answer an open item (a human replied). Returns undefined when absent. */
	answer(key: string, option: string): FakeEscalationItem | undefined;
	/** The run-end sweep: every item claimed by the conversation reopens. */
	runEndSweep(conversationId: number): FakeEscalationItem[];
	/** Whether the provider exists at all (`false` → raise returns absent). */
	available: boolean;
}

let nextEntryId = 1;
export function resetEntryIds(): void {
	nextEntryId = 1;
}
export function userEntry(text: string): {
	id: EntryId;
	conversationId: ConversationId;
	kind: string;
	model: { role: string; content: { type: string; text: string }[] }[];
} {
	return {
		id: nextEntryId++ as EntryId,
		conversationId: 0 as ConversationId,
		kind: "pi.user",
		model: [{ role: "user", content: [{ type: "text", text }] }],
	};
}
export function assistantEntry(): {
	id: EntryId;
	conversationId: ConversationId;
	kind: string;
} {
	return { id: nextEntryId++ as EntryId, conversationId: 0 as ConversationId, kind: "pi.assistant" };
}

/** A pi.tool-result entry for `toolName` with one text block. */
export function toolResultEntry(
	toolName: string,
	text: string,
	callId: string = `${toolName}-1`,
): {
	id: EntryId;
	conversationId: ConversationId;
	kind: string;
	model: unknown[];
} {
	return {
		id: nextEntryId++ as EntryId,
		conversationId: 0 as ConversationId,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: callId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
			},
		],
	};
}

/** A pi.assistant entry carrying one tool call (the args half of a result pair). */
export function toolCallEntry(
	toolName: string,
	args: Record<string, unknown>,
	callId: string = `${toolName}-1`,
): {
	id: EntryId;
	conversationId: ConversationId;
	kind: string;
	model: unknown[];
} {
	return {
		id: nextEntryId++ as EntryId,
		conversationId: 0 as ConversationId,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				toolCalls: [{ id: callId, name: toolName, arguments: args }],
			},
		],
	};
}

export interface FakeHostOptions {
	/** meta.owner for `conversations.meta`. */
	owner?: string;
	/** Throw from `conversations.meta` (afterTool must degrade only the judge's user). */
	metaError?: Error;
	/** meta.jobId for `conversations.meta`. */
	metaJobId?: string;
	/** meta.internal for `conversations.meta`. */
	internal?: boolean;
	/** `jobs.activeRun` result; undefined when absent. */
	activeRun?: { jobId: string; owner?: string };
	/** Transcript entries (oldest first) for `conversations.entries`. */
	entries?: unknown[];
	/** Interaction answers, delivered oldest first as the poll sees them. */
	answers?: FakeAnswer[];
	/** Present → the escalation fakes run. */
	escalations?: FakeEscalations;
	/** Annotation / other published-hook results (queue, last repeats). */
	hookResults?: unknown[];
	/** Queue of `decisions.evaluate` results; the last one repeats. A thunk receives `(request, opts)` and may return a result or THROW (a transport failure). */
	decisionResults?: unknown[];
	/** `models.complete` implementation; absent → a fixed `{text: "card", model: "acme/utility-1"}` reply. */
	complete?: (input: unknown) => Promise<{ text: string; model: string }>;
	/** The stored `settings/<slug>.json` document (absent → `{}`, i.e. all defaults). */
	settings?: Record<string, unknown>;
}

export interface FakeInteractionCalls {
	readonly seeded: readonly InteractionRecord[];
	readonly snapshots: number;
}

export interface FakeNotices {
	readonly posted: readonly {
		user: string;
		key?: string;
		title: string;
		body?: string;
		tone?: string;
	}[];
}

export interface FakePublishedHooks {
	readonly calls: readonly { name: string; payload: unknown; opts: unknown }[];
	/** Queue of results `call` returns in order; the last one repeats. */
	results: unknown[];
}

export interface FakeHost {
	readonly host: SigrunHost;
	readonly root: string;
	readonly publishedHooks: FakePublishedHooks;
	readonly interactions: FakeInteractionCalls;
	readonly notices: FakeNotices;
	readonly escalations: FakeEscalations | undefined;
	/** Every `conversations.entries` query, in order (order assertions). */
	readonly entriesQueries: readonly unknown[];
	/** Every `decisions.evaluate` call (request + opts), in order. */
	readonly decisionCalls: readonly { request: unknown; opts: unknown }[];
	/** Every `models.complete` input, in order. */
	readonly modelCalls: readonly unknown[];
	/** The declaration the warden factory passed to `settings.declare`. */
	readonly declaration: SettingsDeclaration | undefined;
	/** The checked read through THAT declaration (defaults applied, repairs). */
	readSettings(): Promise<Record<string, unknown>>;
	/** Append more `decisions.evaluate` results to the queue. */
	pushDecisionResults(...results: unknown[]): void;
	cleanup(): Promise<void>;
}

/**
 * A structural SigrunHost double for the warden tests. Store paths point
 * at a real temp directory; interactions are driven by the test-side
 * answer queue; published hooks dispatch `mcp.tool-annotations` to the
 * injected result queue and `escalation.*` to the fake item store.
 * Unneeded members throw so a test gap fails loudly.
 */
export async function createFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
	const root = await mkdtemp(join(tmpdir(), "sigrun-warden-fake-host-"));
	const hookCalls: { name: string; payload: unknown; opts: unknown }[] = [];
	const hookResults = [...(options.hookResults ?? [])];
	const seeded: InteractionRecord[] = [];
	let snapshots = 0;
	const answers = [...(options.answers ?? [])];
	const postedNotices: {
		user: string;
		key?: string;
		title: string;
		body?: string;
		tone?: string;
	}[] = [];
	const escalations = options.escalations;
	const entriesQueries: unknown[] = [];
	const decisionCalls: { request: unknown; opts: unknown }[] = [];
	const decisionResults = [...(options.decisionResults ?? [])];
	const modelCalls: unknown[] = [];
	// The stored settings document: raw reads see it as written, the declared
	// handle checks it (defaults applied, malformed values repaired).
	let settingsDoc: Record<string, unknown> = options.settings ?? {};
	const declaration: { current: SettingsDeclaration | undefined; handle?: DeclaredSettings<Record<string, unknown>, Record<string, unknown>> } = {
		current: undefined,
	};
	const notUsed = (): never => {
		throw new Error("not used in warden tests");
	};

	const callEscalation = (
		name: string,
		payload: Record<string, unknown>,
		opts: { conversationId?: number } | undefined,
	): unknown => {
		if (escalations === undefined) return { status: "absent" };
		if (!escalations.available) return { status: "absent" };
		const items = escalations.items;
		if (name === "escalation.raise") {
			const key = payload.key as string;
			const existing = items.find(
				(item) => item.key === key && item.status !== "resolved",
			);
			if (existing !== undefined) {
				return { id: existing.id, created: false, status: existing.status };
			}
			const item: FakeEscalationItem = {
				id: `esc-${items.length + 1}`,
				key,
				namespace: payload.jobId === undefined ? "user" : `job:${payload.jobId}`,
				status: "open",
				created: true,
			};
			items.push(item);
			return { id: item.id, created: true, status: "open" };
		}
		if (name === "escalation.take") {
			const item = items.find(
				(entry) => entry.key === payload.key && entry.status !== "resolved",
			);
			if (item === undefined) return { status: "none" };
			if (item.status === "answered") {
				item.status = "claimed";
				item.claimConversationId = opts?.conversationId;
				return { status: "claimed", id: item.id, option: item.option };
			}
			return { status: item.status, id: item.id };
		}
		if (name === "escalation.resolve") {
			const id = payload.id as string;
			const item = items.find((entry) => entry.id === id);
			if (item === undefined) throw new Error("not_found");
			item.status = "resolved";
			item.resolveOutcome = payload.outcome as "done" | "failed";
			item.resolveNote = payload.note as string;
			return { status: "resolved" };
		}
		return { status: "absent" };
	};

	const host = {
		settings: {
			declare: <S, U = Record<string, unknown>>(
				decl: SettingsDeclaration,
			): DeclaredSettings<S, U> => {
				declaration.current = decl;
				const handle = {
					get: async () =>
						checkStoredSettings(decl.schema, settingsDoc).value as S,
					user: (): { get(): Promise<U> } => {
						throw new Error("the warden declares no per-user settings schema");
					},
				};
				declaration.handle = handle as DeclaredSettings<
					Record<string, unknown>,
					Record<string, unknown>
				>;
				return handle;
			},
		},
		stores: {
			user: notUsed,
			secrets: { get: notUsed, set: notUsed, delete: notUsed },
			settings: {
				get: async () => settingsDoc,
				set: async (value: Record<string, unknown>) => {
					settingsDoc = value;
				},
			},
			paths: {
				data: join(root, "data"),
				state: join(root, "state"),
				cache: join(root, "cache"),
			},
		},
		conversations: {
			meta: async (_id: ConversationId) => {
				if (options.metaError !== undefined) throw options.metaError;
				return {
					...(options.owner === undefined ? {} : { owner: options.owner }),
					...(options.metaJobId === undefined ? {} : { jobId: options.metaJobId }),
					...(options.internal === true ? { internal: true } : {}),
				};
			},
			entries: async (
				_id: ConversationId,
				query: unknown,
				limit: number,
			): Promise<{ items: unknown[]; next?: unknown }> => {
				// Mirror the real host contract: order comes from the query,
				// default `descending` (EntryQuery.order in pi-durable types).
				entriesQueries.push(query);
				const q = query as { order?: string; minEntryId?: number | bigint } | undefined;
				const order = q?.order ?? "descending";
				const minEntryId = q?.minEntryId;
				let items = [...(options.entries ?? [])];
				if (minEntryId !== undefined) {
					const min = Number(minEntryId);
					items = items.filter(
						(entry) => Number((entry as { id: number | bigint }).id) >= min,
					);
				}
				if (order === "descending") items.reverse();
				return { items: items.slice(0, limit) };
			},
			entry: notUsed,
		},
		jobs: {
			activeRun: async (_id: ConversationId) => {
				if (options.activeRun === undefined) return undefined;
				return {
					jobId: options.activeRun.jobId,
					...(options.activeRun.owner === undefined
						? {}
						: { owner: options.activeRun.owner }),
				};
			},
			get: notUsed,
		},
		seedInteraction: async (
			_conversationId: ConversationId,
			record: InteractionRecord,
			_context: unknown,
		): Promise<void> => {
			// First write wins: a re-seed of the same callId is a no-op.
			if (seeded.some((entry) => entry.callId === record.callId)) return;
			seeded.push(record);
		},
		snapshotInteraction: async (
			_conversationId: ConversationId,
			callId: string,
			_context: unknown,
		): Promise<Readonly<InteractionRecord> | undefined> => {
			snapshots += 1;
			const index = seeded.findIndex((entry) => entry.callId === callId);
			if (index < 0) return undefined;
			if (answers.length > 0) {
				// A person's answer lands on the record PERMANENTLY: every
				// waiter on this hold observes it (consumption of the reply is
				// the warden's state concern, not the record's).
				const answer = answers.shift()!;
				seeded[index] = {
					...seeded[index]!,
					status: "answered",
					answeredBy: "human",
					answer: {
						values: {
							decision: answer.decision,
							...(answer.reason === undefined ? {} : { reason: answer.reason }),
						},
					},
				};
			}
			return seeded[index];
		},
		peekInteraction: async (
			_conversationId: ConversationId,
			callId: string,
			_context: unknown,
		): Promise<Readonly<InteractionRecord> | undefined> =>
			seeded.find((entry) => entry.callId === callId),
		publishedHooks: {
			get: () => undefined,
			call: async (name: string, payload: unknown, opts: unknown) => {
				hookCalls.push({ name, payload, opts });
				if (name.startsWith("escalation.")) {
					// Mirror core's PublishedHookResult envelope: a provider's
					// return value rides in `value` under status "ok"; only a
					// missing provider answers the bare `absent`; a provider
					// throw is `failed` (core's registry, src/harness/published-hooks.ts).
					let value: unknown;
					try {
						value = callEscalation(
							name,
							payload as Record<string, unknown>,
							opts as { conversationId?: number } | undefined,
						);
					} catch (error) {
						return {
							status: "failed",
							provider: "sigrun-escalations",
							reason: "threw",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					if ((value as { status?: string }).status === "absent") return value;
					return { status: "ok", provider: "sigrun-escalations", value };
				}
				return hookResults.length > 1
					? hookResults.shift()
					: (hookResults[0] ?? { status: "absent" });
			},
		},
		models: {
			list: async () => [],
			complete: async (input: unknown) => {
				modelCalls.push(input);
				if (options.complete !== undefined) return options.complete(input);
				return { text: "card", model: "acme/utility-1" };
			},
		},
		decisions: {
			evaluate: async (request: unknown, opts: unknown) => {
				decisionCalls.push({ request, opts });
				const next =
					decisionResults.length > 1
						? decisionResults.shift()
						: decisionResults[0];
				if (typeof next === "function") {
					return (next as (request: unknown, opts: unknown) => unknown)(request, opts);
				}
				if (next === undefined) {
					return { ok: false, code: "not_configured", error: "no fake result queued" };
				}
				return next;
			},
			list: async () => [],
		},
		notices: {
			post: async (input: {
				user: string;
				key?: string;
				title: string;
				body?: string;
				tone?: string;
			}) => {
				postedNotices.push(input);
				return { id: `notice-${postedNotices.length}` };
			},
			clear: notUsed,
			list: notUsed,
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
		interactions: {
			get seeded() {
				return seeded;
			},
			get snapshots() {
				return snapshots;
			},
		},
		notices: {
			get posted() {
				return postedNotices;
			},
		},
		escalations,
		entriesQueries,
		decisionCalls,
		modelCalls,
		get declaration() {
			return declaration.current;
		},
		async readSettings(): Promise<Record<string, unknown>> {
			if (declaration.handle === undefined) {
				throw new Error("the factory declared no settings schema");
			}
			return declaration.handle.get();
		},
		pushDecisionResults(...results: unknown[]) {
			decisionResults.push(...results);
		},
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Build a fake escalation bag with the sweep + answer helpers wired. */
export function createFakeEscalations(available = true): FakeEscalations {
	const items: FakeEscalationItem[] = [];
	const calls: { name: string; payload: unknown }[] = [];
	return {
		items,
		get calls() {
			return calls;
		},
		available,
		answer(key, option) {
			const item = items.find((entry) => entry.key === key && entry.status === "open");
			if (item === undefined) return undefined;
			item.status = "answered";
			item.option = option;
			return item;
		},
		runEndSweep(conversationId) {
			const reopened: FakeEscalationItem[] = [];
			for (const item of items) {
				if (item.status !== "claimed") continue;
				if (item.claimConversationId !== conversationId) continue;
				item.status = "answered";
				item.claimConversationId = undefined;
				item.reopenNote = "run ended without resolving the escalation";
				reopened.push(item);
			}
			return reopened;
		},
	};
}
