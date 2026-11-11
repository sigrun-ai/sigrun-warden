/**
 * The warden's declared settings (settings rework, Task 4): one JSON Schema
 * through `host.settings.declare`, so core draws the settings page, applies
 * the defaults and repairs a malformed stored value — the per-key contract
 * the deleted `parseSettings` parser had. Every read that used
 * `host.stores.settings.get()` (the two tool hooks and `/warden card
 * --rebuild`) goes through the declared handle instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type { Principal, SigrunExtensionResult } from "@sigrun/sigrun/extension";

import createWarden from "../src/index.js";
import {
	WARDEN_SETTINGS_SCHEMA,
	defaultSettings,
	type WardenSettings,
} from "../src/settings-schema.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

const ALICE: Principal = { user: "alice", admin: false, service: false, method: "token" };

/** The settings file README.md documents — a live install's shape. */
const OLD_FILE = {
	judge: { enabled: true },
	decisionModel: "acme/judge-1",
	thresholds: { clearAsk: 0.7, card: 0.7, irreversible: 0.9 },
	clearances: [{ job: "ext:acme:cleanup", tools: ["acme-media/torrents_remove"] }],
	rules: [
		{ match: "command", pattern: "rm *", level: "hold" },
		{ match: "tool", pattern: "acme-media/torrents_*", level: "deny" },
		{ match: "path", pattern: "secrets/*", level: "warn" },
	],
	cardModel: "acme/card-1",
	steerBudget: 3,
	retentionDays: { calls: 90, holds: 365 },
};

/** The deleted parser's defaults, key for key. */
const OLD_DEFAULTS = {
	judge: { enabled: true },
	thresholds: { clearAsk: 0.7, card: 0.7, irreversible: 0.9 },
	clearances: [],
	rules: [],
	steerBudget: 3,
	retentionDays: { calls: 90, holds: 365 },
};

describe("warden settings schema", () => {
	const fakes: FakeHost[] = [];
	afterEach(async () => {
		await Promise.all(fakes.splice(0).map((fake) => fake.cleanup()));
	});

	/** A fake host over `settings`, with the factory run so it has declared. */
	async function declared(
		settings?: Record<string, unknown>,
	): Promise<{ fake: FakeHost; factory: SigrunExtensionResult }> {
		const fake = await createFakeHost(settings === undefined ? {} : { settings });
		fakes.push(fake);
		return { fake, factory: createWarden(fake.host) };
	}

	it("model fields declare their kinds", () => {
		const properties = (WARDEN_SETTINGS_SCHEMA as unknown as {
			properties: Record<string, Record<string, unknown>>;
		}).properties;
		expect(properties.decisionModel?.["x-sigrun-model"]).toBe("decision");
		expect(properties.cardModel?.["x-sigrun-model"]).toBe("chat");
	});

	it("the factory declares the Warden title", async () => {
		expect((await declared()).factory.title).toBe("Warden");
	});

	it("schema is drawable", () => {
		assertDrawable(WARDEN_SETTINGS_SCHEMA);
	});

	it("the factory declares the shared schema and no user schema", async () => {
		const { fake } = await declared();
		expect(fake.declaration).toEqual({ schema: WARDEN_SETTINGS_SCHEMA });
	});

	it("defaults match the old parser", async () => {
		// The deleted parseSettings({}, …) result, key for key: judge on, the
		// three thresholds, no clearances, no rules, steerBudget 3, retention
		// 90/365, and both model keys absent (an absent optional key stays
		// absent — the old parser's `undefined`, not an empty string).
		expect(defaultSettings()).toEqual(OLD_DEFAULTS);
		expect(checkStoredSettings(WARDEN_SETTINGS_SCHEMA, {}).value).toEqual(OLD_DEFAULTS);
		expect(await (await declared()).fake.readSettings()).toEqual(OLD_DEFAULTS);
	});

	it("an old settings file still loads", async () => {
		const { fake } = await declared(OLD_FILE);
		// Nothing to repair: the documented shape is schema-valid as written.
		expect(checkStoredSettings(WARDEN_SETTINGS_SCHEMA, OLD_FILE).repairs).toEqual([]);
		expect(await fake.readSettings()).toEqual(OLD_FILE);
	});

	it("clearances keep order and fields", async () => {
		// The form edits entries in place: a reload must keep their order and
		// every field, or a cleared tool silently moves to another job.
		const clearances = [
			{
				job: "ext:acme:cleanup",
				tools: ["acme-media/torrents_remove", "acme-media/torrents_list"],
			},
			{ job: "ext:acme:archive", tools: ["acme-media/import"] },
			{ job: "ext:acme:probe", tools: [] },
		];
		expect((await (await declared({ clearances })).fake.readSettings()).clearances).toEqual(
			clearances,
		);
	});

	it("a malformed value falls back to its default (the old leniency)", async () => {
		// The old parser fell back per key and dropped invalid entries; the
		// checked read repairs the same way instead of quarantining the file.
		const { fake } = await declared({
			judge: { enabled: "yes" },
			thresholds: { clearAsk: 2, card: "high", irreversible: 0.95 },
			steerBudget: -1,
			retentionDays: { calls: "90", holds: 365 },
			rules: "deny everything",
			clearances: [{ job: 42, tools: ["bash"] }],
			decisionModel: "",
			cardModel: 7,
		});
		expect(await fake.readSettings()).toEqual({
			...OLD_DEFAULTS,
			// The one valid value survives.
			thresholds: { clearAsk: 0.7, card: 0.7, irreversible: 0.95 },
		});
	});

	it("a malformed clearance drops only the bad tool", async () => {
		// The one leniency that differs from the old parser: it discarded a
		// whole clearance entry when ANY tool was not a string; the checked
		// read drops just that tool. Never more permissive — an unlisted tool
		// is not cleared — and it keeps the operator's other tools working.
		const { fake } = await declared({
			clearances: [{ job: "ext:acme:cleanup", tools: ["acme-media/torrents_remove", 5] }],
		});
		expect((await fake.readSettings()).clearances).toEqual([
			{ job: "ext:acme:cleanup", tools: ["acme-media/torrents_remove"] },
		]);
	});

	it("a command's write passes the schema", async () => {
		// The warden never writes settings itself (its `/warden` command reads
		// them; there is no settings writer in this extension), so the write
		// this pins is the raw-store one a settings page / operator edit makes:
		// a full settings document written that way must be schema-valid — no
		// repair — and read back unchanged through the declared handle both
		// hooks and the command read with, `cardModel` and clearances included.
		const { fake, factory } = await declared();
		const written: WardenSettings = {
			...defaultSettings(),
			decisionModel: "acme/judge-1",
			clearances: [{ job: "ext:acme:cleanup", tools: ["acme-media/torrents_remove"] }],
			rules: [{ match: "command", pattern: "rm *", level: "hold" }],
			cardModel: "acme/card-1",
			steerBudget: 5,
			retentionDays: { calls: 30, holds: 180 },
		};
		await fake.host.stores.settings.set(written as unknown as Record<string, unknown>);
		expect(checkStoredSettings(WARDEN_SETTINGS_SCHEMA, written).repairs).toEqual([]);
		expect(await fake.readSettings()).toEqual(written);

		const command = factory.commands?.find((entry) => entry.name === "warden");
		expect(command).toBeDefined();
		const result = await command!.run({
			conversationId: 7 as never,
			args: "cards",
			principal: ALICE,
			host: fake.host,
		});
		expect(result?.notice).toBe("no cards");
	});
});
