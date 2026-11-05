/**
 * Task 13 cards tests: the CardStore round-trip and `buildCard`'s
 * single-flight, failure, size-cap, and model-selection contract over
 * `host.models.complete`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCard, CARD_SYSTEM_PROMPT, CardStore } from "../src/cards.js";
import { defaultSettings } from "../src/settings.js";
import type { WardenSettings } from "../src/settings.js";
import type { SkillSeen } from "../src/skills.js";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";

const BODY = "Cleanup finished torrents.\n1. Run torrents_list first.\n2. Then torrents_remove may run.";
const EDITED = `${BODY}\n3. Never touch seeding torrents.`;

function skill(body: string): SkillSeen {
	return {
		name: "acme-cleanup",
		location: "skills/acme-cleanup/SKILL.md",
		body,
		hash: createHash("sha256").update(body, "utf8").digest("hex"),
	};
}

function settingsWith(patch: Partial<WardenSettings>): WardenSettings {
	return { ...defaultSettings(), ...patch };
}

describe("CardStore", () => {
	let root: string;
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("put/get/list round-trips cards under paths.data/cards", async () => {
		root = await mkdtemp(join(tmpdir(), "sigrun-warden-cards-"));
		const store = new CardStore(root);
		const card = {
			hash: "abc123",
			skill: "acme-cleanup",
			location: "skills/acme-cleanup/SKILL.md",
			builtAt: new Date().toISOString(),
			model: "acme/utility-1",
			text: "## torrents_remove\n…",
		};
		await store.put(card);
		expect(await store.get("abc123")).toEqual(card);
		expect(await store.get("missing")).toBeUndefined();
		expect(await store.list()).toEqual([card]);
	});
});

describe("buildCard", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
	});

	it("stores a card keyed by the body hash", async () => {
		fake = await createFakeHost();
		const s = skill(BODY);
		const card = await buildCard(fake.host, s, defaultSettings());
		expect(card).toBeDefined();
		expect(card!.hash).toBe(s.hash);
		expect(card!.skill).toBe("acme-cleanup");
		expect(card!.location).toBe("skills/acme-cleanup/SKILL.md");
		expect(card!.text).toBe("card");
		expect(card!.model).toBe("acme/utility-1");
		const store = new CardStore(fake.host.stores.paths.data);
		expect(await store.get(s.hash)).toEqual(card);
	});

	it("an edited body builds a second card", async () => {
		fake = await createFakeHost();
		const first = await buildCard(fake.host, skill(BODY), defaultSettings());
		const second = await buildCard(fake.host, skill(EDITED), defaultSettings());
		expect(first!.hash).not.toBe(second!.hash);
		const store = new CardStore(fake.host.stores.paths.data);
		expect(await store.list()).toHaveLength(2);
	});

	it("a model failure yields undefined and stores nothing", async () => {
		fake = await createFakeHost({
			complete: async () => {
				throw new Error("no provider");
			},
		});
		const card = await buildCard(fake.host, skill(BODY), defaultSettings());
		expect(card).toBeUndefined();
		const store = new CardStore(fake.host.stores.paths.data);
		expect(await store.list()).toEqual([]);
	});

	it("a 9000-byte answer yields undefined and stores nothing", async () => {
		fake = await createFakeHost({
			complete: async () => ({ text: "x".repeat(9000), model: "acme/utility-1" }),
		});
		const card = await buildCard(fake.host, skill(BODY), defaultSettings());
		expect(card).toBeUndefined();
		const store = new CardStore(fake.host.stores.paths.data);
		expect(await store.list()).toEqual([]);
	});

	it("two concurrent builds for one hash call the model once", async () => {
		fake = await createFakeHost();
		const s = skill(BODY);
		const [a, b] = await Promise.all([
			buildCard(fake.host, s, defaultSettings()),
			buildCard(fake.host, s, defaultSettings()),
		]);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(fake.modelCalls).toHaveLength(1);
	});

	it("cardModel is passed as model, else role utility", async () => {
		fake = await createFakeHost();
		await buildCard(fake.host, skill(BODY), defaultSettings());
		let input = fake.modelCalls[0] as { model?: string; role?: string; timeoutMs?: number };
		expect(input.model).toBeUndefined();
		expect(input.role).toBe("utility");
		expect(input.timeoutMs).toBe(60_000);

		fake = await createFakeHost();
		await buildCard(
			fake.host,
			skill(BODY),
			settingsWith({ cardModel: "acme/card-1" }),
		);
		input = fake.modelCalls[0] as { model?: string; role?: string };
		expect(input.model).toBe("acme/card-1");
		expect(input.role).toBeUndefined();
	});

	it("the prompt carries the card system prompt and the skill body", async () => {
		fake = await createFakeHost();
		await buildCard(fake.host, skill(BODY), defaultSettings());
		const input = fake.modelCalls[0] as { systemPrompt?: string; prompt: string };
		expect(input.systemPrompt).toBe(CARD_SYSTEM_PROMPT);
		expect(input.prompt).toContain(BODY);
	});
});
