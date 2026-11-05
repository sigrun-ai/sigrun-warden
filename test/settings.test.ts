import { describe, expect, it } from "vitest";

import {
	defaultSettings,
	parseSettings,
	resetWarnedKeys,
	type WardenSettings,
} from "../src/settings.js";

function expectDefaults(settings: WardenSettings): void {
	expect(settings.judge).toEqual({ enabled: true });
	expect(settings.thresholds).toEqual({
		clearAsk: 0.7,
		card: 0.7,
		irreversible: 0.9,
	});
	expect(settings.clearances).toEqual([]);
	expect(settings.rules).toEqual([]);
	expect(settings.steerBudget).toBe(3);
	expect(settings.retentionDays).toEqual({ calls: 90, holds: 365 });
	expect(settings.decisionModel).toBeUndefined();
	expect(settings.cardModel).toBeUndefined();
}

describe("parseSettings", () => {
	it("returns all defaults for an empty document", () => {
		resetWarnedKeys();
		const warnings: string[] = [];
		expectDefaults(parseSettings({}, (m) => warnings.push(m)));
		expect(warnings).toEqual([]);
	});

	it("parses a complete valid document", () => {
		resetWarnedKeys();
		const warnings: string[] = [];
		const settings = parseSettings(
			{
				judge: { enabled: false },
				decisionModel: "example/judge-1",
				thresholds: { clearAsk: 0.5, card: 0.8, irreversible: 1 },
				clearances: [{ job: "acme-media", tools: ["bash", "write"] }],
				rules: [
					{ match: "command", pattern: "rm *", level: "hold" },
					{ match: "tool", pattern: "acme-media/torrents_*", level: "deny" },
					{ match: "path", pattern: "/tmp/*", level: "warn" },
				],
				cardModel: "example/card-1",
				steerBudget: 5,
				retentionDays: { calls: 30, holds: 180 },
			},
			(m) => warnings.push(m),
		);
		expect(warnings).toEqual([]);
		expect(settings.judge.enabled).toBe(false);
		expect(settings.decisionModel).toBe("example/judge-1");
		expect(settings.thresholds).toEqual({ clearAsk: 0.5, card: 0.8, irreversible: 1 });
		expect(settings.clearances).toEqual([
			{ job: "acme-media", tools: ["bash", "write"] },
		]);
		expect(settings.rules).toHaveLength(3);
		expect(settings.cardModel).toBe("example/card-1");
		expect(settings.steerBudget).toBe(5);
		expect(settings.retentionDays).toEqual({ calls: 30, holds: 180 });
	});

	it("falls back per key with one warning per key", () => {
		resetWarnedKeys();
		const warnings: string[] = [];
		const settings = parseSettings(
			{
				judge: { enabled: "yes" },
				thresholds: { clearAsk: 2, card: "high", irreversible: 0.95 },
				steerBudget: -1,
				retentionDays: { calls: "90", holds: 365 },
				rules: "deny everything",
				clearances: [{ job: 42, tools: ["bash"] }],
				decisionModel: "",
				cardModel: 7,
			},
			(m) => warnings.push(m),
		);
		// Every invalid key fell back; the valid ones survived.
		expect(settings.judge.enabled).toBe(true);
		expect(settings.thresholds).toEqual({ clearAsk: 0.7, card: 0.7, irreversible: 0.95 });
		expect(settings.steerBudget).toBe(3);
		expect(settings.retentionDays).toEqual({ calls: 90, holds: 365 });
		expect(settings.rules).toEqual([]);
		expect(settings.clearances).toEqual([]);
		expect(settings.decisionModel).toBeUndefined();
		expect(settings.cardModel).toBeUndefined();
		// One warning per invalid key, naming it.
		expect(warnings).toContain('warden settings: invalid "judge.enabled", using default');
		expect(warnings).toContain('warden settings: invalid "thresholds.clearAsk", using default');
		expect(warnings).toContain('warden settings: invalid "thresholds.card", using default');
		expect(warnings).toContain('warden settings: invalid "steerBudget", using default');
		expect(warnings).toContain('warden settings: invalid "retentionDays.calls", using default');
		expect(warnings).toContain('warden settings: invalid "rules", using default');
		expect(warnings).toContain('warden settings: invalid "clearances", using default');
		expect(warnings).toContain('warden settings: invalid "decisionModel", using default');
		expect(warnings).toContain('warden settings: invalid "cardModel", using default');
		// No duplicate warnings for one key.
		expect(new Set(warnings).size).toBe(warnings.length);
	});

	it("warns a given key only once per process", () => {
		resetWarnedKeys();
		const warnings: string[] = [];
		parseSettings({ steerBudget: "three" }, (m) => warnings.push(m));
		parseSettings({ steerBudget: "three" }, (m) => warnings.push(m));
		expect(warnings).toEqual(['warden settings: invalid "steerBudget", using default']);
		resetWarnedKeys();
		parseSettings({ steerBudget: "three" }, (m) => warnings.push(m));
		expect(warnings).toHaveLength(2);
	});
});

describe("defaultSettings", () => {
	it("matches the spec defaults", () => {
		expectDefaults(defaultSettings());
	});
});
