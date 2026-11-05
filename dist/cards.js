/**
 * Skill cards (warden spec §3.4): a compact digest of one skill body,
 * built once per body hash by `host.models.complete` and stored under
 * the warden's data root. A build yields `undefined` on any failure or
 * an answer over 8192 bytes; builds are single-flight per hash.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const CARD_MAX_BYTES = 8192;
export const CARD_TIMEOUT_MS = 60_000;
/** The system prompt for one card build: quote the skill, invent nothing. */
export const CARD_SYSTEM_PROMPT = `You are writing a rule card for one skill, from the skill text alone.

For EACH tool the skill names as destructive (remove, delete, import, deny, unmatch, purge, blocklist, and similar actions that change or destroy data), write one heading:

## <tool>

Under each heading write exactly three bullet lists:

**Allowed without asking when:** the exact conditions the skill states.
**Evidence required first:** which earlier lookups the skill requires, and what they must show. Quote the skill's own check names and values.
**Escalate instead when:** the exact conditions the skill states.

Quote the skill's own thresholds, limits, and names verbatim. Do not invent conditions, thresholds, tools, or evidence steps the skill does not name. If the skill names no destructive tools, answer exactly: no destructive tools.`;
/** The warden's card store: one JSON file per card at `<dataDir>/cards/<hash>.json`. */
export class CardStore {
    #dir;
    /** `dataDir` is the warden's `host.stores.paths.data`. */
    constructor(dataDir) {
        this.#dir = join(dataDir, "cards");
    }
    async get(hash) {
        let raw;
        try {
            raw = await readFile(join(this.#dir, `${hash}.json`), "utf8");
        }
        catch {
            return undefined;
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    async put(card) {
        await mkdir(this.#dir, { recursive: true });
        await writeFile(join(this.#dir, `${card.hash}.json`), `${JSON.stringify(card, null, 2)}\n`, "utf8");
    }
    async list() {
        let names;
        try {
            names = await readdir(this.#dir);
        }
        catch {
            return [];
        }
        const cards = [];
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const card = await this.get(name.slice(0, -".json".length));
            if (card !== undefined)
                cards.push(card);
        }
        // Newest build first.
        cards.sort((a, b) => (a.builtAt < b.builtAt ? 1 : a.builtAt > b.builtAt ? -1 : 0));
        return cards;
    }
}
/**
 * In-flight builds, keyed by body hash: concurrent builds for one hash
 * call the model once (spec §3.4 single-flight). Module-scoped — one
 * process, one warden instance.
 */
const inflight = new Map();
/** Test hook: drop the single-flight map (a failed build must not pin a test). */
export function resetInflightForTests() {
    inflight.clear();
}
/**
 * Build (or fetch the in-flight build of) the card for one skill body.
 * `undefined` on any failure or an answer over the byte cap; the caller
 * (an afterTool background task or `/warden card --rebuild`) treats
 * undefined as "no card" and never blocks on it.
 */
export function buildCard(host, skill, settings) {
    const existing = inflight.get(skill.hash);
    if (existing !== undefined)
        return existing;
    const build = buildCardUncached(host, skill, settings).finally(() => {
        inflight.delete(skill.hash);
    });
    inflight.set(skill.hash, build);
    return build;
}
async function buildCardUncached(host, skill, settings) {
    let answer;
    try {
        answer = await host.models.complete({
            ...(settings.cardModel === undefined
                ? { role: "utility" }
                : { model: settings.cardModel }),
            systemPrompt: CARD_SYSTEM_PROMPT,
            prompt: `Skill: ${skill.name}\n\n${skill.body}`,
            timeoutMs: CARD_TIMEOUT_MS,
        });
    }
    catch {
        return undefined;
    }
    if (Buffer.byteLength(answer.text, "utf8") > CARD_MAX_BYTES)
        return undefined;
    const card = {
        hash: skill.hash,
        skill: skill.name,
        ...(skill.location === undefined ? {} : { location: skill.location }),
        builtAt: new Date().toISOString(),
        model: answer.model,
        text: answer.text,
    };
    const store = new CardStore(host.stores.paths.data);
    try {
        await store.put(card);
    }
    catch {
        return undefined;
    }
    return card;
}
