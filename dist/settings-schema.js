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
import { Type } from "typebox";
/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` type stays on the original.
 */
function asJsonSchema(schema) {
    return schema;
}
/** What a rule's pattern is matched against (`classify.ts`'s rule targets). */
const RULE_MATCH_SCHEMA = Type.Union([Type.Literal("command"), Type.Literal("path"), Type.Literal("tool")], {
    title: "Match",
    description: "What the pattern is matched against: the raw command string, any string argument, or the tool name.",
    "x-sigrun-apply": "live",
});
/** `deny` blocks the call, `hold` makes it destructive, `warn` only logs it. */
const RULE_LEVEL_SCHEMA = Type.Union([Type.Literal("warn"), Type.Literal("hold"), Type.Literal("deny")], {
    title: "Level",
    description: "`deny` blocks the call, `hold` makes it destructive, `warn` only logs.",
    "x-sigrun-apply": "live",
});
/**
 * One rule of the rule list. The old parser dropped an entry whose `match`,
 * `pattern` or `level` was missing or outside the listed values; the
 * checked read drops the same entries.
 */
const RULE_SCHEMA = Type.Object({
    match: RULE_MATCH_SCHEMA,
    pattern: Type.String({
        title: "Pattern",
        description: "Anchored `*`-only glob; `?` and `**` are literal.",
        "x-sigrun-apply": "live",
    }),
    level: RULE_LEVEL_SCHEMA,
}, {
    title: "Rule",
    description: "One rule over a command, a path, or a tool name.",
    "x-sigrun-summary": ["match", "pattern", "level"],
});
/**
 * One clearance: a job that may run the listed tools autonomously, each
 * call only after its per-target card check passes. The old parser dropped
 * an entry without a string `job` and a list of strings `tools`.
 */
const CLEARANCE_SCHEMA = Type.Object({
    job: Type.String({
        title: "Job",
        description: "The job's id (`ext:<extension>:<job>`) or a fire's id.",
        "x-sigrun-apply": "live",
    }),
    tools: Type.Array(Type.String({
        title: "Tool",
        description: "A tool name, e.g. `acme-media/torrents_remove`.",
    }), {
        title: "Tools",
        description: "The tools this job may run autonomously.",
        "x-sigrun-apply": "live",
    }),
}, {
    title: "Clearance",
    description: "A job's autonomous tool list.",
    "x-sigrun-key": "job",
    "x-sigrun-summary": ["job", "tools"],
});
/** A threshold: a judgment score in 0..1, both ends inclusive (the old parser's bound). */
function threshold(title, description, defaultValue) {
    return Type.Number({
        title,
        description,
        minimum: 0,
        maximum: 1,
        default: defaultValue,
        "x-sigrun-apply": "live",
    });
}
/**
 * A retention window in days. The old parser took any finite value >= 0;
 * `restart` because the hold log prunes once per process.
 */
function retention(title, description, defaultValue) {
    return Type.Number({
        title,
        description,
        minimum: 0,
        default: defaultValue,
        "x-sigrun-apply": "restart",
    });
}
/** The deleted parser's defaults, key for key — the schema's own `default`s. */
const DEFAULTS = {
    judge: { enabled: true },
    thresholds: { clearAsk: 0.7, card: 0.7, irreversible: 0.9 },
    steerBudget: 3,
    retentionDays: { calls: 90, holds: 365 },
};
export const WARDEN_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
    judge: Type.Object({
        enabled: Type.Boolean({
            title: "Enabled",
            description: "False: no judge calls at all. Every unjudged call then holds on the person (live) or blocks + escalates (a job).",
            default: DEFAULTS.judge.enabled,
            "x-sigrun-apply": "live",
        }),
    }, {
        title: "Judge",
        description: "The decision model's clear-ask judgment.",
        default: { ...DEFAULTS.judge },
        "x-sigrun-apply": "live",
    }),
    decisionModel: Type.Optional(Type.String({
        title: "Decision model",
        description: "The `provider/model` the judge calls. Absent: the core decisions model.",
        minLength: 1,
        "x-sigrun-apply": "live",
        "x-sigrun-model": "decision",
    })),
    thresholds: Type.Object({
        clearAsk: threshold("Clear ask", "At or above this score a clearly-named live call runs without asking the person.", DEFAULTS.thresholds.clearAsk),
        card: threshold("Card", "At or above this score a cleared job call meets its card check; below it the call blocks + escalates.", DEFAULTS.thresholds.card),
        irreversible: threshold("Irreversible", "At or above this score an unclassified shell command or unannotated MCP tool counts as destructive.", DEFAULTS.thresholds.irreversible),
    }, {
        title: "Thresholds",
        description: "The judge's score thresholds, each in 0..1.",
        default: { ...DEFAULTS.thresholds },
        "x-sigrun-apply": "live",
    }),
    clearances: Type.Array(CLEARANCE_SCHEMA, {
        title: "Clearances",
        description: "Jobs allowed to run the listed tools autonomously, each only after its per-target card check passes.",
        default: [],
        "x-sigrun-apply": "live",
    }),
    rules: Type.Array(RULE_SCHEMA, {
        title: "Rules",
        description: "Rules over commands, paths and tool names; `deny` blocks, `warn` logs.",
        default: [],
        "x-sigrun-apply": "live",
    }),
    cardModel: Type.Optional(Type.String({
        title: "Card model",
        description: "The `provider/model` used to build skill cards. Absent: core's utility role.",
        minLength: 1,
        "x-sigrun-apply": "live",
        "x-sigrun-model": "chat",
    })),
    steerBudget: Type.Number({
        title: "Steer budget",
        description: "Steers per run before the warden asks the person itself instead of steering the model again.",
        minimum: 0,
        default: DEFAULTS.steerBudget,
        "x-sigrun-apply": "live",
    }),
    retentionDays: Type.Object({
        calls: retention("Calls", "Days of call records the hold log keeps.", DEFAULTS.retentionDays.calls),
        holds: retention("Holds", "Days of hold records the hold log keeps.", DEFAULTS.retentionDays.holds),
    }, {
        title: "Retention days",
        description: "How long the hold log keeps each record class. Pruning runs once per process, so a new window takes effect at the next boot.",
        default: { ...DEFAULTS.retentionDays },
        "x-sigrun-apply": "restart",
    }),
}));
/**
 * A fresh copy of the declared defaults (`DEFAULTS`, the schema's own
 * `default`s). Internal call sites and test fixtures overlay it; every call
 * returns new blocks, so no two callers share one object.
 */
export function defaultSettings() {
    return {
        judge: { ...DEFAULTS.judge },
        thresholds: { ...DEFAULTS.thresholds },
        clearances: [],
        rules: [],
        steerBudget: DEFAULTS.steerBudget,
        retentionDays: { ...DEFAULTS.retentionDays },
    };
}
