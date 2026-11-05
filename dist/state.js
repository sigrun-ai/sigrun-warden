/**
 * Per-conversation warden state (`paths.state/conv/<id>.json`): blocked
 * records (24 h), live-question releases, and job grant reservations.
 * Writes are serialized in-process then atomic (temp + rename).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * The escalation key / call fingerprint: `warden:` + the first 16 hex of
 * sha256(tool + "\n" + canonical JSON of the arguments, keys sorted).
 * Canonicalization is recursive so argument order never splits a grant.
 */
export function grantKey(tool, args) {
    const canonical = canonicalize(args);
    const digest = createHash("sha256")
        .update(tool)
        .update("\n")
        .update(canonical)
        .digest("hex");
    return `warden:${digest.slice(0, 16)}`;
}
function canonicalize(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "undefined";
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
    const record = value;
    const keys = Object.keys(record).sort();
    const body = keys
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(",");
    return `{${body}}`;
}
export function emptyState() {
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
    #dir;
    #now;
    #locks = new Map();
    constructor(stateDir, now = () => new Date()) {
        this.#dir = join(stateDir, "conv");
        this.#now = now;
    }
    async load(id) {
        let text;
        try {
            text = await readFile(this.#path(id), "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return emptyState();
            throw error;
        }
        try {
            return { ...emptyState(), ...JSON.parse(text) };
        }
        catch {
            // A torn write must never brick the warden (fail closed on state).
            return emptyState();
        }
    }
    async update(id, fn) {
        const prior = this.#locks.get(id) ?? Promise.resolve();
        const run = prior.then(() => this.#updateInner(id, fn));
        this.#locks.set(id, run.catch(() => {
            // A failed update must not poison the chain for the next caller.
        }));
        return run;
    }
    async #updateInner(id, fn) {
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
    #prune(state) {
        const cutoff = this.#now().getTime() - BLOCKED_TTL_MS;
        const kept = state.blocked.filter((record) => {
            const at = Date.parse(record.at);
            return !Number.isFinite(at) || at >= cutoff;
        });
        if (kept.length === state.blocked.length)
            return;
        const keptFingerprints = new Set(kept.map((record) => record.fingerprint));
        state.blocked = kept;
        state.released = state.released.filter((release) => keptFingerprints.has(release.fingerprint));
    }
    #path(id) {
        return join(this.#dir, `${id}.json`);
    }
}
