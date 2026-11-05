/**
 * Where the tool call is happening (warden spec §3.2 presence classes):
 * an internal curator run, a scheduled job run, or a live conversation.
 */
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";

export type Presence =
	| { kind: "live"; owner?: string }
	| { kind: "job"; jobId: string; owner?: string }
	| { kind: "internal" };

/**
 * Classify the conversation the hook is running in. `meta.internal` wins
 * (a curator run never escalates); otherwise the job whose fire is
 * currently running in this conversation decides job-vs-live.
 */
export async function presenceOf(
	host: SigrunHost,
	conversationId: ConversationId,
): Promise<Presence> {
	const meta = await host.conversations.meta(conversationId);
	if (meta.internal === true) return { kind: "internal" };
	const run = await host.jobs.activeRun(conversationId);
	if (run !== undefined) {
		return {
			kind: "job",
			jobId: run.jobId,
			...(run.owner === undefined ? {} : { owner: run.owner }),
		};
	}
	return {
		kind: "live",
		...(meta.owner === undefined ? {} : { owner: meta.owner }),
	};
}

/** The current run's context, from the newest user input entry. */
export interface RunInfo {
	/** The newest user-input entry (this run's start), absent when none. */
	runStart: EntryId | undefined;
	/** The newest user input's text ("" when unreachable). */
	request: string;
	/** The tail of `request` (last 3000 chars) for prompt-style use. */
	asked: string;
	/** This run's entries (from `runStart` on), oldest first. */
	entries: readonly EntryRecord[];
}

const ASKED_MAX = 3000;

/** Extract the visible text of one entry's first user-model message. */
function userText(entry: EntryRecord): string {
	const messages = entry.model;
	if (messages === undefined || messages.length === 0) return "";
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
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

/**
 * Read the run a held call belongs to. Tolerant by contract: it feeds
 * the judge's clear-ask input (Task 12), so an unreadable history yields
 * an empty run rather than throwing (beforeTool never fails through it —
 * the hook still wraps everything, but this keeps the failure mode a
 * simple degraded context).
 */
export async function runInfo(
	host: SigrunHost,
	conversationId: ConversationId,
): Promise<RunInfo> {
	let records: EntryRecord[];
	try {
		// Newest-first probe: find the newest "pi.user" entry id. Anchoring
		// the window at it keeps the run current even when the transcript
		// outgrows a single page — a plain ascending page would read the
		// OLDEST entries and freeze runStart near the conversation start.
		const probe = await host.conversations.entries(
			conversationId,
			{ order: "descending" },
			200,
			undefined,
		);
		const newestUser = probe.items.find((entry) => entry.kind === "pi.user");
		if (newestUser === undefined) {
			// No user input in the newest page: fall back to the plain
			// ascending read (whole page / empty run).
			const page = await host.conversations.entries(
				conversationId,
				{ order: "ascending" },
				200,
				undefined,
			);
			records = [...page.items];
		} else {
			// The run window: from the newest user input onward, oldest
			// first — what runStart/request/asked/entries derive from.
			const page = await host.conversations.entries(
				conversationId,
				{ order: "ascending", minEntryId: newestUser.id },
				200,
				undefined,
			);
			records = [...page.items];
		}
	} catch {
		return { runStart: undefined, request: "", asked: "", entries: [] };
	}
	// The window starts at the newest user input, so the first "pi.user"
	// entry walking forward is the run start (kept as a scan so the
	// fallback page — which may predate it — still anchors correctly).
	let startIndex = -1;
	for (let i = 0; i < records.length; i += 1) {
		if (records[i]!.kind === "pi.user") {
			startIndex = i;
			break;
		}
	}
	if (startIndex < 0) {
		return { runStart: undefined, request: "", asked: "", entries: records };
	}
	const runEntries = records.slice(startIndex);
	const request = userText(runEntries[0]!);
	return {
		runStart: runEntries[0]!.id,
		request,
		asked: request.slice(-ASKED_MAX),
		entries: runEntries,
	};
}
