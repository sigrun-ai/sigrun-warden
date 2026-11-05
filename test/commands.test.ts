/**
 * Task 13 commands tests: the `/warden` command — `cards` lists,
 * `card <skill>` shows the newest card, `--rebuild` rebuilds from the
 * body seen in this conversation (or explains when there is none).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { buildCard, CardStore } from "../src/cards.js";
import { createWardenCommands } from "../src/commands.js";
import { defaultSettings } from "../src/settings.js";
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

	function wardenCommand(entries: EntryRecord[]) {
		fakeEntries = entries;
		return createWardenCommands(fake.host)[0]!;
	}

	let fakeEntries: EntryRecord[] = [];

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
		const command = wardenCommand([]);
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
		const command = wardenCommand([]);
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
		const command = wardenCommand([userEntry("please clean up") as unknown as EntryRecord]);
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
		const command = wardenCommand(entries);
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
});
