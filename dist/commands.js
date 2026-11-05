import { buildCard, CardStore } from "./cards.js";
import { HoldLog } from "./log.js";
import { parseSettings } from "./settings.js";
import { skillsInRun } from "./skills.js";
const RUN_PAGE = 500;
/** Build the warden's slash commands over the host (one per factory). */
export function createWardenCommands(host) {
    return [
        {
            name: "warden",
            description: "Skill cards: list, show, rebuild; hold log: list",
            args: "cards | card <skill> [--rebuild] | holds [n]",
            run: async (ctx) => ({
                notice: await runWardenCommands(host, ctx.conversationId, ctx.args),
            }),
        },
    ];
}
async function runWardenCommands(host, conversationId, args) {
    const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
    const [sub, ...rest] = words;
    if (sub === "cards")
        return cardsList(host);
    if (sub === "card") {
        const rebuild = rest.includes("--rebuild");
        const skill = rest.find((word) => word !== "--rebuild");
        if (skill === undefined)
            return "usage: /warden card <skill> [--rebuild]";
        if (rebuild)
            return cardRebuild(host, conversationId, skill);
        return cardShow(host, skill);
    }
    if (sub === "holds")
        return holdsList(host, rest[0]);
    return "usage: /warden cards | /warden card <skill> [--rebuild] | /warden holds [n]";
}
const HOLDS_DEFAULT = 20;
/**
 * `/warden holds [n]` (warden spec §3.6): the newest `n` hold-log
 * records, NEWEST FIRST (default 20; n <= 0 → an empty listing). The
 * log's `call` field is stored redacted (route.ts appends through
 * pi-warden's `redact`), so the listing renders it verbatim — never
 * re-derive from anything unmasked.
 */
async function holdsList(host, countArg) {
    let n = HOLDS_DEFAULT;
    if (countArg !== undefined) {
        const parsed = Number.parseInt(countArg, 10);
        if (!Number.isFinite(parsed))
            return "usage: /warden holds [n]";
        n = parsed;
    }
    if (n <= 0)
        return "";
    const log = new HoldLog(`${host.stores.paths.state}/holds.jsonl`, () => new Date());
    const records = await log.recent(n);
    if (records.length === 0)
        return "no holds recorded";
    // `recent` is oldest-first within the window; the listing is newest first.
    return records.reverse().map(holdLine).join("\n");
}
function holdLine(record) {
    const parts = [
        record.at,
        `conv ${String(record.conversationId)}`,
        record.tool,
        record.action,
    ];
    if (record.outcome !== undefined)
        parts.push(record.outcome);
    return parts.join(" · ");
}
async function cardsList(host) {
    const store = new CardStore(host.stores.paths.data);
    const cards = await store.list();
    if (cards.length === 0)
        return "no cards";
    return cards.map((card) => cardLine(card)).join("\n");
}
function cardLine(card) {
    return `${card.skill} · ${card.hash.slice(0, 8)} · ${card.builtAt} · ${card.model}`;
}
async function cardShow(host, skill) {
    const store = new CardStore(host.stores.paths.data);
    const cards = (await store.list()).filter((card) => card.skill === skill);
    if (cards.length === 0)
        return `no card for ${skill}`;
    return cards[0].text;
}
async function cardRebuild(host, conversationId, skill) {
    // Newest page first: a skill loaded late in a long run must be found.
    const page = await host.conversations.entries(conversationId, { order: "descending" }, RUN_PAGE, undefined);
    const seen = skillsInRun(page.items);
    const copy = seen.find((entry) => entry.name === skill);
    if (copy === undefined) {
        return `no copy of ${skill} in this conversation; load it first`;
    }
    const raw = await host.stores.settings.get();
    const settings = parseSettings(raw, (message) => console.warn(message));
    const card = await buildCard(host, copy, settings);
    if (card === undefined)
        return `card build failed for ${skill}`;
    return card.text;
}
