/**
 * Per-conversation warden state (`paths.state/conv/<id>.json`): blocked
 * records (24 h), live-question releases, and job grant reservations.
 * Writes are serialized in-process then atomic (temp + rename).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryId } from "@earendil-works/pi-durable";

/**
 * The escalation key / call fingerprint: `warden:` + the first 16 hex of
 * sha256(tool + "\n" + canonical JSON of the arguments, keys sorted).
 * Canonicalization is recursive so argument order never splits a grant.
 */
export function grantKey(tool: string, args: Record<string, unknown>): string {
	const canonical = canonicalize(args);
	const digest = createHash("sha256")
		.update(tool)
		.update("\n")
		.update(canonical)
		.digest("hex");
	return `warden:${digest.slice(0, 16)}`;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const body = keys
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",");
	return `{${body}}`;
}

export interface ConversationState {
	/** The newest user-input entry of the current run (run boundary). Serialized as a number. */
	runStart?: EntryId;
	/** Set when a deny/destructive call was blocked this run (Task 14/15). */
	tainted?: boolean;
	steers: number;
	/**
	 * Held calls, kept across runs for 24 h, consumed on release.
	 * `afterEntry` carries the hold NONCE (the interaction callId suffix:
	 * `warden-<fingerprint>-<nonce>`); `status` tracks the hold lifecycle:
	 * pending → answered (consumed) → released (one call released).
	 */
	blocked: {
		fingerprint: string;
		at: string;
		/** The hold NONCE (the interaction callId suffix) for the Task 11 hold path. */
		afterEntry?: string;
		/** The newest entry id the block sits after (Task 12: the reply anchor). */
		atEntry?: string;
		status?: "pending" | "answered" | "released";
	}[];
	/** Answered allows consumed once; a reply releases one call. */
	released: { fingerprint: string; replyEntry: string }[];
	/** One in-flight execution per grant (job presence). */
	reservations: { grantKey: string; callId: string; escalationId: string }[];
}

/** The fingerprint of one call: the grant key WITHOUT the `warden:` prefix. */
export function callFingerprint(call: {
	name: string;
	arguments: Record<string, unknown>;
}): string {
	return grantKey(call.name, call.arguments).slice("warden:".length);
}

export function emptyState(): ConversationState {
	return { steers: 0, blocked: [], released: [], reservations: [] };
}

const BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The on-disk store. `update` runs `fn` under a per-conversation
 * in-process lock and persists the result atomically. A change of
 * `runStart` (a new run) resets the run-scoped fields — `steers` and
 * `taint` — while 24 h `blocked` records and `reservations` persist;
 * `released` entries prune with their blocked record.
 */
export class StateStore {
	readonly #dir: string;
	readonly #now: () => Date;
	readonly #locks = new Map<number, Promise<unknown>>();

	constructor(stateDir: string, now: () => Date = () => new Date()) {
		this.#dir = join(stateDir, "conv");
		this.#now = now;
	}

	async load(id: number): Promise<ConversationState> {
		let text: string;
		try {
			text = await readFile(this.#path(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			throw error;
		}
		try {
			return { ...emptyState(), ...(JSON.parse(text) as Partial<ConversationState>) };
		} catch {
			// A torn write must never brick the warden (fail closed on state).
			return emptyState();
		}
	}

	async update<T>(id: number, fn: (s: ConversationState) => T | Promise<T>): Promise<T> {
		const prior = this.#locks.get(id) ?? Promise.resolve();
		const run = prior.then(() => this.#updateInner(id, fn));
		this.#locks.set(
			id,
			run.catch(() => {
				// A failed update must not poison the chain for the next caller.
			}),
		);
		return run;
	}

	async #updateInner<T>(id: number, fn: (s: ConversationState) => T | Promise<T>): Promise<T> {
		const state = await this.load(id);
		this.#prune(state);
		const result = await fn(state);
		await mkdir(this.#dir, { recursive: true });
		const tmp = `${this.#path(id)}.tmp`;
		await writeFile(tmp, `${JSON.stringify(state)}\n`, "utf8");
		await rename(tmp, this.#path(id));
		return result;
	}

	/** Drop expired 24 h blocked records (and their releases). */
	#prune(state: ConversationState): void {
		const cutoff = this.#now().getTime() - BLOCKED_TTL_MS;
		const kept = state.blocked.filter((record) => {
			const at = Date.parse(record.at);
			return !Number.isFinite(at) || at >= cutoff;
		});
		if (kept.length === state.blocked.length) return;
		const keptFingerprints = new Set(kept.map((record) => record.fingerprint));
		state.blocked = kept;
		state.released = state.released.filter((release) =>
			keptFingerprints.has(release.fingerprint),
		);
	}

	#path(id: number): string {
		return join(this.#dir, `${id}.json`);
	}
}
