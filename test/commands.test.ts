/**
 * Task 13 commands tests: the `/warden` command — `cards` lists,
 * `card <skill>` shows the newest card, `--rebuild` rebuilds from the
 * body seen in this conversation (or explains when there is none).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { redact } from "pi-warden";

import { buildCard, CardStore } from "../src/cards.js";
import { HoldLog } from "../src/log.js";
import createWarden from "../src/index.js";
import { defaultSettings } from "../src/settings-schema.js";
import {
	createFakeHost,
	resetEntryIds,
	toolCallEntry,
	toolResultEntry,
	userEntry,
	type FakeHost,
} from "./fake-host.js";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { Principal } from "@sigrun/sigrun/extension";

const BODY = "Cleanup finished torrents.\n1. Run torrents_list first.\n2. Then torrents_remove may run.";
const OTHER = "A different skill body.";

function hashOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

const ALICE: Principal = {
	user: "alice",
	admin: false,
	service: false,
	method: "token",
};

const CONVERSATION = 7 as ConversationId;

describe("/warden commands", () => {
	let fake: FakeHost;
	beforeEach(() => {
		resetEntryIds();
	});
	afterEach(async () => {
		await fake.cleanup();
	});

	function wardenCommand() {
		// The command surface the extension actually publishes: it reads
		// settings through the handle the factory declared.
		return createWarden(fake.host).commands![0]!;
	}

	it("cards lists", async () => {
		fake = await createFakeHost({});
		const card1 = await buildCard(
			fake.host,
			{ name: "acme-cleanup", location: "skills/acme-cleanup/SKILL.md", body: BODY, hash: hashOf(BODY) },
			defaultSettings(),
		);
		const card2 = await buildCard(
			fake.host,
			{ name: "acme-tidy", body: OTHER, hash: hashOf(OTHER) },
			defaultSettings(),
		);
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "cards",
			principal: ALICE,
			host: fake.host,
		});
		const notice = result?.notice ?? "";
		for (const card of [card1!, card2!]) {
			expect(notice).toContain(card.skill);
			expect(notice).toContain(card.hash.slice(0, 8));
			expect(notice).toContain(card.builtAt);
			expect(notice).toContain(card.model);
		}
	});

	it("card shows", async () => {
		fake = await createFakeHost({});
		const card = await buildCard(
			fake.host,
			{ name: "acme-cleanup", body: BODY, hash: hashOf(BODY) },
			defaultSettings(),
		);
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "card acme-cleanup",
			principal: ALICE,
			host: fake.host,
		});
		expect(result?.notice).toContain(card!.text);
	});

	it("--rebuild without a copy explains", async () => {
		fake = await createFakeHost({});
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "card acme-cleanup --rebuild",
			principal: ALICE,
			host: fake.host,
		});
		expect(result?.notice).toBe(
			"no copy of acme-cleanup in this conversation; load it first",
		);
		expect(fake.modelCalls).toHaveLength(0);
	});

	it("--rebuild rebuilds from the newest body seen in this conversation", async () => {
		const entries = [
			userEntry("please run it"),
			toolCallEntry("load_skill", { skill: "acme-cleanup" }),
			toolResultEntry("load_skill", BODY),
		] as unknown as EntryRecord[];
		fake = await createFakeHost({ entries });
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "card acme-cleanup --rebuild",
			principal: ALICE,
			host: fake.host,
		});
		expect(fake.modelCalls).toHaveLength(1);
		// The rebuilt card is keyed by THIS conversation's body and returned.
		const store = new CardStore(fake.host.stores.paths.data);
		const card = await store.get(hashOf(BODY));
		expect(card).toBeDefined();
		expect(card!.skill).toBe("acme-cleanup");
		expect(result?.notice).toBe(card!.text);
	});

	it("--rebuild pages newest-first so a skill loaded LATE in a long conversation is found", async () => {
		// 502 entries; the skill load sits at the very END. An
		// oldest-first page of 500 fills on the chatter and never sees
		// it; a newest-first page does.
		const entries: EntryRecord[] = [];
		for (let i = 0; i < 500; i++) {
			entries.push(userEntry(`chatter ${i}`) as unknown as EntryRecord);
		}
		entries.push(
			toolCallEntry("load_skill", { skill: "acme-cleanup" }) as unknown as EntryRecord,
			toolResultEntry("load_skill", BODY) as unknown as EntryRecord,
		);
		fake = await createFakeHost({ entries });
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "card acme-cleanup --rebuild",
			principal: ALICE,
			host: fake.host,
		});
		expect(fake.modelCalls).toHaveLength(1);
		const store = new CardStore(fake.host.stores.paths.data);
		const card = await store.get(hashOf(BODY));
		expect(card).toBeDefined();
		expect(result?.notice).toBe(card!.text);
	});

	it("holds lists the newest n records, redacted", async () => {
		fake = await createFakeHost({});
		const log = new HoldLog(
			`${fake.host.stores.paths.state}/holds.jsonl`,
			() => new Date(),
		);
		const SECRET = "sk-live-warden-secret-value";
		// Four records, oldest first; the middle one carries a masked
		// secret in `call` (the same shape every append writes).
		const seeds = [
			{ at: "2026-01-01T00:00:01.000Z", tool: "bash", action: "steer" as const },
			{ at: "2026-01-01T00:00:02.000Z", tool: "acme-media/torrents_remove", action: "hold" as const, outcome: "approved" as const, call: redact(JSON.stringify({ token: SECRET, ids: [7] })) },
			{ at: "2026-01-01T00:00:03.000Z", tool: "bash", action: "block" as const, outcome: "declined" as const },
			{ at: "2026-01-01T00:00:04.000Z", tool: "acme-media/torrents_list", action: "allow-judged" as const },
		];
		for (const seed of seeds) {
			await log.append({
				conversationId: 7,
				call: "{}",
				...seed,
			});
		}
		const command = wardenCommand();
		const result = await command.run({
			conversationId: CONVERSATION,
			args: "holds 2",
			principal: ALICE,
			host: fake.host,
		});
		const notice = result?.notice ?? "";
		const lines = notice.split("\n");
		// Newest FIRST, exactly n=2.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("2026-01-01T00:00:04.000Z");
		expect(lines[0]).toContain("acme-media/torrents_list");
		expect(lines[1]).toContain("2026-01-01T00:00:03.000Z");
		expect(lines[1]).toContain("block");
		expect(lines[1]).toContain("declined");
		// The stored raw secret never reaches the listing (the record was
		// seeded REDACTED; the listing renders what the log holds).
		expect(notice).not.toContain(SECRET);

		// Default n=20 covers all four; the whole log stays redacted.
		const all = await command.run({
			conversationId: CONVERSATION,
			args: "holds",
			principal: ALICE,
			host: fake.host,
		});
		const allLines = (all?.notice ?? "").split("\n");
		expect(allLines).toHaveLength(4);
		expect(allLines[0]).toContain("00:00:04");
		expect(allLines[3]).toContain("00:00:01");
		expect(all?.notice).not.toContain(SECRET);

		// n <= 0 → empty; no log file → a clean sentence.
		const zero = await command.run({
			conversationId: CONVERSATION,
			args: "holds 0",
			principal: ALICE,
			host: fake.host,
		});
		expect(zero?.notice).toBe("");
		const empty = await createFakeHost({});
		try {
			const emptyResult = await createWarden(empty.host).commands![0]!.run({
				conversationId: CONVERSATION,
				args: "holds",
				principal: ALICE,
				host: empty.host,
			});
			expect(emptyResult?.notice).toBe("no holds recorded");
		} finally {
			await empty.cleanup();
		}
	});
});
