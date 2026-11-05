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
    judge: {
        enabled: boolean;
    };
    decisionModel?: string;
    thresholds: WardenThresholds;
    clearances: readonly WardenClearance[];
    rules: readonly WardenRule[];
    cardModel?: string;
    steerBudget: number;
    retentionDays: WardenRetentionDays;
}
export declare function defaultSettings(): WardenSettings;
/** Test hook: clear the once-per-process warn dedup. */
export declare function resetWarnedKeys(): void;
/**
 * Parse the raw settings document. `raw` is the settings-store value; an
 * absent or non-object raw value yields all defaults. Each invalid key
 * warns once per process and falls back independently.
 */
export declare function parseSettings(raw: Record<string, unknown>, warn: (message: string) => void): WardenSettings;
