/**
 * Warden settings: parsed from the extension's settings document
 * (the extension's own scoped settings document, `settings/sigrun-warden.json`).
 * Every invalid value falls back
 * to its default with ONE `console.warn` naming the key, at most once
 * per key per process — `parseSettings` runs per factory, so the dedup
 * set is module-scoped; tests that need a fresh warn pass new keys or
 * call `resetWarnedKeys()` (test hook).
 */

export interface WardenThresholds {
	clearAsk: number;
	card: number;
	irreversible: number;
}

export interface WardenClearance {
	job: string;
	tools: readonly string[];
}

export interface WardenRule {
	match: "command" | "path" | "tool";
	pattern: string;
	level: "warn" | "hold" | "deny";
}

export interface WardenRetentionDays {
	calls: number;
	holds: number;
}

export interface WardenSettings {
	judge: { enabled: boolean };
	decisionModel?: string;
	thresholds: WardenThresholds;
	clearances: readonly WardenClearance[];
	rules: readonly WardenRule[];
	cardModel?: string;
	steerBudget: number;
	retentionDays: WardenRetentionDays;
}

export function defaultSettings(): WardenSettings {
	return {
		judge: { enabled: true },
		thresholds: { clearAsk: 0.7, card: 0.7, irreversible: 0.9 },
		clearances: [],
		rules: [],
		steerBudget: 3,
		retentionDays: { calls: 90, holds: 365 },
	};
}

/** Warned-key dedup, module-scoped ("once per key per process"). */
const warnedKeys = new Set<string>();

/** Test hook: clear the once-per-process warn dedup. */
export function resetWarnedKeys(): void {
	warnedKeys.clear();
}

function warnOnce(warn: (message: string) => void, key: string): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	warn(`warden settings: invalid "${key}", using default`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function booleanAt(
	warn: (message: string) => void,
	key: string,
	value: unknown,
	fallback: boolean,
): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnOnce(warn, key);
	return fallback;
}

function numberAt(
	warn: (message: string) => void,
	key: string,
	value: unknown,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (isNumber(value) && value >= 0) return value;
	warnOnce(warn, key);
	return fallback;
}

function thresholdAt(
	warn: (message: string) => void,
	key: string,
	value: unknown,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (isNumber(value) && value >= 0 && value <= 1) return value;
	warnOnce(warn, key);
	return fallback;
}

function stringAt(
	warn: (message: string) => void,
	key: string,
	value: unknown,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.length > 0) return value;
	warnOnce(warn, key);
	return undefined;
}

const RULE_MATCHES = ["command", "path", "tool"] as const;
const RULE_LEVELS = ["warn", "hold", "deny"] as const;

/**
 * Parse the raw settings document. `raw` is the settings-store value; an
 * absent or non-object raw value yields all defaults. Each invalid key
 * warns once per process and falls back independently.
 */
export function parseSettings(
	raw: Record<string, unknown>,
	warn: (message: string) => void,
): WardenSettings {
	const defaults = defaultSettings();
	if (!isPlainObject(raw)) return defaults;

	const rawJudge = raw.judge;
	const judgeEnabled =
		rawJudge === undefined
			? defaults.judge.enabled
			: !isPlainObject(rawJudge)
				? (warnOnce(warn, "judge"), defaults.judge.enabled)
				: booleanAt(warn, "judge.enabled", rawJudge.enabled, defaults.judge.enabled);

	const rawThresholds = raw.thresholds;
	const thresholds: WardenThresholds = { ...defaults.thresholds };
	if (raw.thresholds !== undefined && !isPlainObject(rawThresholds)) {
		warnOnce(warn, "thresholds");
	} else if (isPlainObject(rawThresholds)) {
		thresholds.clearAsk = thresholdAt(
			warn,
			"thresholds.clearAsk",
			rawThresholds.clearAsk,
			defaults.thresholds.clearAsk,
		);
		thresholds.card = thresholdAt(
			warn,
			"thresholds.card",
			rawThresholds.card,
			defaults.thresholds.card,
		);
		thresholds.irreversible = thresholdAt(
			warn,
			"thresholds.irreversible",
			rawThresholds.irreversible,
			defaults.thresholds.irreversible,
		);
	}

	let clearances: readonly WardenClearance[] = defaults.clearances;
	if (raw.clearances !== undefined) {
		if (Array.isArray(raw.clearances)) {
			const parsed: WardenClearance[] = [];
			for (const entry of raw.clearances) {
				if (
					isPlainObject(entry) &&
					typeof entry.job === "string" &&
					Array.isArray(entry.tools) &&
					entry.tools.every((tool) => typeof tool === "string")
				) {
					parsed.push({ job: entry.job, tools: entry.tools as readonly string[] });
				} else {
					warnOnce(warn, "clearances");
				}
			}
			clearances = parsed;
		} else {
			warnOnce(warn, "clearances");
		}
	}

	let rules: readonly WardenRule[] = defaults.rules;
	if (raw.rules !== undefined) {
		if (Array.isArray(raw.rules)) {
			const parsed: WardenRule[] = [];
			for (const entry of raw.rules) {
				if (
					isPlainObject(entry) &&
					RULE_MATCHES.includes(entry.match as WardenRule["match"]) &&
					typeof entry.pattern === "string" &&
					RULE_LEVELS.includes(entry.level as WardenRule["level"])
				) {
					parsed.push({
						match: entry.match as WardenRule["match"],
						pattern: entry.pattern,
						level: entry.level as WardenRule["level"],
					});
				} else {
					warnOnce(warn, "rules");
				}
			}
			rules = parsed;
		} else {
			warnOnce(warn, "rules");
		}
	}

	const rawRetention = raw.retentionDays;
	const retentionDays: WardenRetentionDays = { ...defaults.retentionDays };
	if (rawRetention !== undefined && !isPlainObject(rawRetention)) {
		warnOnce(warn, "retentionDays");
	} else if (isPlainObject(rawRetention)) {
		retentionDays.calls = numberAt(
			warn,
			"retentionDays.calls",
			rawRetention.calls,
			defaults.retentionDays.calls,
		);
		retentionDays.holds = numberAt(
			warn,
			"retentionDays.holds",
			rawRetention.holds,
			defaults.retentionDays.holds,
		);
	}

	const settings: WardenSettings = {
		judge: { enabled: judgeEnabled },
		thresholds,
		clearances,
		rules,
		steerBudget: numberAt(warn, "steerBudget", raw.steerBudget, defaults.steerBudget),
		retentionDays,
	};
	const decisionModel = stringAt(warn, "decisionModel", raw.decisionModel);
	if (decisionModel !== undefined) settings.decisionModel = decisionModel;
	const cardModel = stringAt(warn, "cardModel", raw.cardModel);
	if (cardModel !== undefined) settings.cardModel = cardModel;
	return settings;
}
