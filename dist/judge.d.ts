/**
 * The decisions judge (warden spec §3.2): a pi-warden `Judge` over
 * core's `host.decisions.evaluate`. Core NEVER throws (failures arrive
 * as the `ok:false` half of DecisionResult); pi-warden's ask paths
 * expect the pi-typesafe contract — the raw SystemOneResult on success
 * and a THROW on failure — so this adapter converts the failure half
 * into `Error("<code>: <error>")`.
 *
 * The `Cooldown` pauses a failing judge instance-wide (in memory): 3
 * consecutive failures pause judgments for 5 minutes; a success resets
 * the streak.
 */
import type { Judge } from "pi-typesafe";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { WardenSettings } from "./settings-schema.js";
/**
 * Session-scoped pause on a failing judge: three consecutive failures
 * pause judgment calls for five minutes. Nothing is persisted; a new
 * process starts with the judge trusted again.
 */
export declare class Cooldown {
    #private;
    /** The default reads Date.now on each call, so a test can mock the clock. */
    constructor(now?: () => number);
    /** Record one judge failure; the third consecutive one opens the window. */
    failed(): void;
    /** A successful judgment clears the streak and the window. */
    succeeded(): void;
    /** True while judgments are paused. */
    get active(): boolean;
}
/**
 * The judge for one settings snapshot: `undefined` when the judge is
 * disabled or the cooldown is active. The evaluate implementation:
 *
 * - calls `host.decisions.evaluate(request, {model: settings.decisionModel, user, signal})`;
 * - on `ok:true` returns the RAW Evaluation shape `{answers, usage, model, elapsedMs}`;
 * - on `ok:false` throws `Error("<code>: <error>")` so pi-warden's and
 *   our ask paths see a failure;
 * - every outcome updates the cooldown (thrown transport errors count
 *   as failures too).
 */
export declare function decisionsJudge(host: SigrunHost, settings: WardenSettings, cooldown: Cooldown, user?: string): Judge | undefined;
