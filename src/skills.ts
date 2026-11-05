/**
 * Skills in the run (warden spec §3.4 card sources): a skill reaches a
 * run three ways — a `<skill name="…" location="…">` block expanded
 * into a user/job prompt, a `load_skill` result (its call's args name
 * the skill), or a `read` of a path ending SKILL.md. `skillsInRun`
 * collects them from the run's entries, deduped by the sha256 of the
 * body, newest first (the most recent copy governs).
 */
import { createHash } from "node:crypto";
import type { EntryRecord } from "@earendil-works/pi-durable";

export interface SkillSeen {
	name: string;
	location?: string;
	body: string;
	/** sha256 hex of the body. */
	hash: string;
}

export interface SkillTag {
	name: string;
	location?: string;
}

const SKILL_TAG_RE =
	/<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>/g;

/** Extract `<skill name="…" location="…">` tags from expanded text. */
export function skillTagsInText(text: string): SkillTag[] {
	const tags: SkillTag[] = [];
	SKILL_TAG_RE.lastIndex = 0;
	for (;;) {
		const match = SKILL_TAG_RE.exec(text);
		if (match === null) break;
		const name = match[1]!;
		const location = match[2];
		tags.push(location === undefined ? { name } : { name, location });
	}
	return tags;
}

/** The text blocks of one entry's model messages, joined. */
function entryText(entry: EntryRecord): string {
	const messages = entry.model;
	if (messages === undefined || messages.length === 0) return "";
	const parts: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
				}
			}
		}
	}
	return parts.join("\n");
}

interface ToolCallRef {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/** Tool calls one entry carries (assistant messages' toolCalls). */
function entryToolCalls(entry: EntryRecord): ToolCallRef[] {
	const calls: ToolCallRef[] = [];
	for (const message of entry.model ?? []) {
		const list = (message as { toolCalls?: unknown }).toolCalls;
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			if (typeof raw !== "object" || raw === null) continue;
			const call = raw as { id?: unknown; name?: unknown; arguments?: unknown };
			if (typeof call.id !== "string" || typeof call.name !== "string") continue;
			calls.push({
				id: call.id,
				name: call.name,
				args:
					typeof call.arguments === "object" && call.arguments !== null
						? (call.arguments as Record<string, unknown>)
						: {},
			});
		}
	}
	return calls;
}

interface ToolResultRef {
	callId: string;
	toolName: string;
	text: string;
}

/** Tool results one entry carries (toolResult messages). */
function entryToolResults(entry: EntryRecord): ToolResultRef[] {
	const results: ToolResultRef[] = [];
	for (const message of entry.model ?? []) {
		if ((message as { role?: unknown }).role !== "toolResult") continue;
		const m = message as {
			toolCallId?: unknown;
			toolName?: unknown;
			content?: unknown;
		};
		if (typeof m.toolCallId !== "string" || typeof m.toolName !== "string") continue;
		const parts: string[] = [];
		if (typeof m.content === "string") {
			parts.push(m.content);
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
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

function bodyHash(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Collect the skills the run saw, newest first, deduped by body hash.
 * Input `entries` may be in either order; the newest copy of a body
 * wins and the result sorts by first-seen recency (the entry id of
 * each body's newest sighting, descending).
 */
export function skillsInRun(entries: readonly EntryRecord[]): SkillSeen[] {
	// Pair tool calls with results by callId (results reference calls).
	const calls = new Map<string, ToolCallRef>();
	for (const entry of entries) {
		for (const call of entryToolCalls(entry)) {
			calls.set(call.id, call);
		}
	}

	// body hash → { skill, newest entry id } — dedup keeps the newest.
	const byHash = new Map<string, { skill: SkillSeen; seenAt: bigint }>();

	const collect = (seen: SkillSeen, at: bigint): void => {
		const existing = byHash.get(seen.hash);
		if (existing === undefined || at > existing.seenAt) {
			byHash.set(seen.hash, { skill: seen, seenAt: at });
		}
	};

	for (const entry of entries) {
		const id = BigInt(entry.id as unknown as number | bigint);
		// Channel 1: <skill> blocks in expanded user/job prompts. One
		// scan consumes every block, so two same-named blocks each hash
		// their own body.
		if (entry.kind === "pi.user" || entry.kind === "sigrun.user.expanded") {
			const text = entryText(entry);
			for (const block of skillBlocksInText(text)) {
				collect(
					{
						name: block.name,
						...(block.location === undefined ? {} : { location: block.location }),
						body: block.body,
						hash: bodyHash(block.body),
					},
					id,
				);
			}
		}
		// Channels 2/3: tool results paired with their calls.
		for (const result of entryToolResults(entry)) {
			const call = calls.get(result.callId);
			if (result.toolName === "load_skill") {
				const name =
					typeof call?.args.skill === "string"
						? call.args.skill
						: typeof call?.args.name === "string"
							? call.args.name
							: undefined;
				if (name === undefined || result.text.length === 0) continue;
				collect({ name, body: result.text, hash: bodyHash(result.text) }, id);
			} else if (result.toolName === "read") {
				const path = typeof call?.args.path === "string" ? call.args.path : undefined;
				if (path === undefined || !path.endsWith("SKILL.md")) continue;
				if (result.text.length === 0) continue;
				// The skill name is the parent directory's leaf.
				const segments = path.split("/").filter((part) => part.length > 0);
				const name =
					segments.length >= 2 ? segments[segments.length - 2]! : segments[0]!;
				collect(
					{ name, location: path, body: result.text, hash: bodyHash(result.text) },
					id,
				);
			}
		}
	}

	return [...byHash.values()]
		.sort((a, b) => (a.seenAt > b.seenAt ? -1 : a.seenAt < b.seenAt ? 1 : 0))
		.map((entry) => entry.skill);
}

const SKILL_BLOCK_RE =
	/<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>([\s\S]*?)<\/skill>/g;

// Core's expansion (dist/commands/expand.js) prefixes the body with a
// `References are relative to <dir>.` preamble line and a blank line —
// neither is part of the skill body (and the absolute dir must never
// reach a card prompt).
const CORE_PREAMBLE_RE = /^References are relative to \S+\.\n\n/;

export interface SkillBlock {
	name: string;
	location?: string;
	body: string;
}

/**
 * Every `<skill name="…">…</skill>` block in the text, in order. The
 * body is trimmed of one surrounding newline pair and of core's
 * `References are relative to …` preamble, so it equals the SKILL.md
 * text the other channels capture.
 */
export function skillBlocksInText(text: string): SkillBlock[] {
	const blocks: SkillBlock[] = [];
	SKILL_BLOCK_RE.lastIndex = 0;
	for (;;) {
		const match = SKILL_BLOCK_RE.exec(text);
		if (match === null) break;
		const body = match[3]!
			.replace(/^\n/, "")
			.replace(/\n$/, "")
			.replace(CORE_PREAMBLE_RE, "");
		const name = match[1]!;
		const location = match[2];
		blocks.push(
			location === undefined ? { name, body } : { name, location, body },
		);
	}
	return blocks;
}
