import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { WardenSettings } from "./settings.js";
import type { SkillSeen } from "./skills.js";
export interface Card {
    hash: string;
    skill: string;
    location?: string;
    builtAt: string;
    model: string;
    /** ≤ 8192 bytes. */
    text: string;
}
export declare const CARD_MAX_BYTES = 8192;
export declare const CARD_TIMEOUT_MS = 60000;
/** The system prompt for one card build: quote the skill, invent nothing. */
export declare const CARD_SYSTEM_PROMPT = "You are writing a rule card for one skill, from the skill text alone.\n\nFor EACH tool the skill names as destructive (remove, delete, import, deny, unmatch, purge, blocklist, and similar actions that change or destroy data), write one heading:\n\n## <tool>\n\nUnder each heading write exactly three bullet lists:\n\n**Allowed without asking when:** the exact conditions the skill states.\n**Evidence required first:** which earlier lookups the skill requires, and what they must show. Quote the skill's own check names and values.\n**Escalate instead when:** the exact conditions the skill states.\n\nQuote the skill's own thresholds, limits, and names verbatim. Do not invent conditions, thresholds, tools, or evidence steps the skill does not name. If the skill names no destructive tools, answer exactly: no destructive tools.";
/** The warden's card store: one JSON file per card at `<dataDir>/cards/<hash>.json`. */
export declare class CardStore {
    #private;
    /** `dataDir` is the warden's `host.stores.paths.data`. */
    constructor(dataDir: string);
    get(hash: string): Promise<Card | undefined>;
    put(card: Card): Promise<void>;
    list(): Promise<Card[]>;
}
/** Test hook: drop the single-flight map (a failed build must not pin a test). */
export declare function resetInflightForTests(): void;
/**
 * Build (or fetch the in-flight build of) the card for one skill body.
 * `undefined` on any failure or an answer over the byte cap; the caller
 * (an afterTool background task or `/warden card --rebuild`) treats
 * undefined as "no card" and never blocks on it.
 */
export declare function buildCard(host: SigrunHost, skill: SkillSeen, settings: WardenSettings): Promise<Card | undefined>;
