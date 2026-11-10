/**
 * The warden's declared settings (settings rework, Task 4): the whole
 * operator surface as one JSON Schema, declared through
 * `host.settings.declare`. Core generates the settings page's form from it,
 * applies the defaults and repairs a malformed stored value back to its
 * default — the per-key fall-back the deleted `parseSettings` parser had,
 * now with a load-time warning and an admin notice instead of a silent
 * `console.warn`.
 *
 * Nobody reads settings during the factory: this extension's declared name
 * (`sigrun.warden`) resolves to the slug `sigrun-warden` while its package
 * is `@sigrun/warden` (the loader's provisional slug `warden`), so a
 * factory-time read would resolve the file the settings page never writes —
 * core's slug-mismatch gate names that bug. Every read is per tool call, so
 * each property is `live` — except `retentionDays`: the hold log prunes once
 * per process (`startPruneOnce`), so a new window lands at the next boot.
 */
import { Type, type Static } from "typebox";
export declare const WARDEN_SETTINGS_SCHEMA: Type.TObject<{
    judge: Type.TObject<{
        enabled: Type.TBoolean;
    }>;
    decisionModel: Type.TOptional<Type.TString>;
    thresholds: Type.TObject<{
        clearAsk: Type.TNumber;
        card: Type.TNumber;
        irreversible: Type.TNumber;
    }>;
    clearances: Type.TArray<Type.TObject<{
        job: Type.TString;
        tools: Type.TArray<Type.TString>;
    }>>;
    rules: Type.TArray<Type.TObject<{
        match: Type.TUnion<[Type.TLiteral<"command">, Type.TLiteral<"path">, Type.TLiteral<"tool">]>;
        pattern: Type.TString;
        level: Type.TUnion<[Type.TLiteral<"warn">, Type.TLiteral<"hold">, Type.TLiteral<"deny">]>;
    }>>;
    cardModel: Type.TOptional<Type.TString>;
    steerBudget: Type.TNumber;
    retentionDays: Type.TObject<{
        calls: Type.TNumber;
        holds: Type.TNumber;
    }>;
}> & Readonly<Record<string, unknown>>;
export type WardenSettings = Static<typeof WARDEN_SETTINGS_SCHEMA>;
/**
 * A fresh copy of the declared defaults (`DEFAULTS`, the schema's own
 * `default`s). Internal call sites and test fixtures overlay it; every call
 * returns new blocks, so no two callers share one object.
 */
export declare function defaultSettings(): WardenSettings;
