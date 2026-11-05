/**
 * Skills in the run (warden spec §3.4 card sources): a skill reaches a
 * run three ways — a `<skill name="…" location="…">` block expanded
 * into a user/job prompt, a `load_skill` result (its call's args name
 * the skill), or a `read` of a path ending SKILL.md. `skillsInRun`
 * collects them from the run's entries, deduped by the sha256 of the
 * body, newest first (the most recent copy governs).
 */
import { createHash } from "node:crypto";
const SKILL_TAG_RE = /<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>/g;
/** Extract `<skill name="…" location="…">` tags from expanded text. */
export function skillTagsInText(text) {
    const tags = [];
    SKILL_TAG_RE.lastIndex = 0;
    for (;;) {
        const match = SKILL_TAG_RE.exec(text);
        if (match === null)
            break;
        const name = match[1];
        const location = match[2];
        tags.push(location === undefined ? { name } : { name, location });
    }
    return tags;
}
/** The text blocks of one entry's model messages, joined. */
function entryText(entry) {
    const messages = entry.model;
    if (messages === undefined || messages.length === 0)
        return "";
    const parts = [];
    for (const message of messages) {
        const content = message.content;
        if (typeof content === "string") {
            parts.push(content);
        }
        else if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === "object" &&
                    block !== null &&
                    block.type === "text" &&
                    typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
        }
    }
    return parts.join("\n");
}
/** Tool calls one entry carries (assistant messages' toolCalls). */
function entryToolCalls(entry) {
    const calls = [];
    for (const message of entry.model ?? []) {
        const list = message.toolCalls;
        if (!Array.isArray(list))
            continue;
        for (const raw of list) {
            if (typeof raw !== "object" || raw === null)
                continue;
            const call = raw;
            if (typeof call.id !== "string" || typeof call.name !== "string")
                continue;
            calls.push({
                id: call.id,
                name: call.name,
                args: typeof call.arguments === "object" && call.arguments !== null
                    ? call.arguments
                    : {},
            });
        }
    }
    return calls;
}
/** Tool results one entry carries (toolResult messages). */
function entryToolResults(entry) {
    const results = [];
    for (const message of entry.model ?? []) {
        if (message.role !== "toolResult")
            continue;
        const m = message;
        if (typeof m.toolCallId !== "string" || typeof m.toolName !== "string")
            continue;
        const parts = [];
        if (typeof m.content === "string") {
            parts.push(m.content);
        }
        else if (Array.isArray(m.content)) {
            for (const block of m.content) {
                if (typeof block === "object" &&
                    block !== null &&
                    block.type === "text" &&
                    typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
        }
        results.push({
            callId: m.toolCallId,
            toolName: m.toolName,
            text: parts.join("\n"),
        });
    }
    return results;
}
function bodyHash(body) {
    return createHash("sha256").update(body, "utf8").digest("hex");
}
/**
 * Collect the skills the run saw, newest first, deduped by body hash.
 * Input `entries` may be in either order; the newest copy of a body
 * wins and the result sorts by first-seen recency (the entry id of
 * each body's newest sighting, descending).
 */
export function skillsInRun(entries) {
    // Pair tool calls with results by callId (results reference calls).
    const calls = new Map();
    for (const entry of entries) {
        for (const call of entryToolCalls(entry)) {
            calls.set(call.id, call);
        }
    }
    // body hash → { skill, newest entry id } — dedup keeps the newest.
    const byHash = new Map();
    const collect = (seen, at) => {
        const existing = byHash.get(seen.hash);
        if (existing === undefined || at > existing.seenAt) {
            byHash.set(seen.hash, { skill: seen, seenAt: at });
        }
    };
    for (const entry of entries) {
        const id = BigInt(entry.id);
        // Channel 1: <skill> blocks in expanded user/job prompts.
        if (entry.kind === "pi.user" || entry.kind === "sigrun.user.expanded") {
            const text = entryText(entry);
            for (const tag of skillTagsInText(text)) {
                // The body is the text of the skill's SKILL.md as expanded;
                // the tag text alone carries name/location. When the body
                // follows the tag inside the block, capture the block's text.
                const body = skillBodyForTag(text, tag.name);
                if (body === undefined)
                    continue;
                collect({
                    name: tag.name,
                    ...(tag.location === undefined ? {} : { location: tag.location }),
                    body,
                    hash: bodyHash(body),
                }, id);
            }
        }
        // Channels 2/3: tool results paired with their calls.
        for (const result of entryToolResults(entry)) {
            const call = calls.get(result.callId);
            if (result.toolName === "load_skill") {
                const name = typeof call?.args.skill === "string"
                    ? call.args.skill
                    : typeof call?.args.name === "string"
                        ? call.args.name
                        : undefined;
                if (name === undefined || result.text.length === 0)
                    continue;
                collect({ name, body: result.text, hash: bodyHash(result.text) }, id);
            }
            else if (result.toolName === "read") {
                const path = typeof call?.args.path === "string" ? call.args.path : undefined;
                if (path === undefined || !path.endsWith("SKILL.md"))
                    continue;
                if (result.text.length === 0)
                    continue;
                // The skill name is the parent directory's leaf.
                const segments = path.split("/").filter((part) => part.length > 0);
                const name = segments.length >= 2 ? segments[segments.length - 2] : segments[0];
                collect({ name, location: path, body: result.text, hash: bodyHash(result.text) }, id);
            }
        }
    }
    return [...byHash.values()]
        .sort((a, b) => (a.seenAt > b.seenAt ? -1 : a.seenAt < b.seenAt ? 1 : 0))
        .map((entry) => entry.skill);
}
/** The body inside `<skill name="…">…</skill>` (undefined when unclosed). */
function skillBodyForTag(text, name) {
    const open = new RegExp(`<skill\\s+name="${escapeRegExp(name)}"(?:\\s+location="[^"]*")?\\s*>`).exec(text);
    if (open === null)
        return undefined;
    const close = text.indexOf("</skill>", open.index + open[0].length);
    if (close < 0)
        return undefined;
    const body = text.slice(open.index + open[0].length, close);
    // Trim ONE surrounding newline pair — the block expansion indents the
    // body between the tags.
    return body.replace(/^\n/, "").replace(/\n$/, "");
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
