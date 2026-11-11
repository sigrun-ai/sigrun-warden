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
import type { Evaluation, Judge } from "pi-typesafe";
import type { SystemOneRequest } from "pi-typesafe";
import type { Questions } from "pi-typesafe";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { DecisionRequest, DecisionResult } from "@sigrun/shared/decisions";

import type { WardenSettings } from "./settings-schema.js";

const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Session-scoped pause on a failing judge: three consecutive failures
 * pause judgment calls for five minutes. Nothing is persisted; a new
 * process starts with the judge trusted again.
 */
export class Cooldown {
	readonly #now: () => number;
	#failures = 0;
	#until = 0;

	/** The default reads Date.now on each call, so a test can mock the clock. */
	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	/** Record one judge failure; the third consecutive one opens the window. */
	failed(): void {
		this.#failures += 1;
		if (this.#failures >= FAILURE_LIMIT) {
			this.#until = this.#now() + COOLDOWN_MS;
		}
	}

	/** A successful judgment clears the streak and the window. */
	succeeded(): void {
		this.#failures = 0;
		this.#until = 0;
	}

	/** True while judgments are paused. */
	get active(): boolean {
		return this.#until > this.#now();
	}
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
export function decisionsJudge(
	host: SigrunHost,
	settings: WardenSettings,
	cooldown: Cooldown,
	user?: string,
): Judge | undefined {
	if (!settings.judge.enabled) return undefined;
	if (cooldown.active) return undefined;
	return {
		evaluate: async <Q extends Questions>(
			request: SystemOneRequest<Q>,
			options?: { signal?: AbortSignal },
		): Promise<Evaluation<Q>> => {
			let result: DecisionResult;
			try {
				result = await host.decisions.evaluate(request as unknown as DecisionRequest, {
					model: settings.decisionModel,
					user,
					signal: options?.signal,
				});
			} catch (error) {
				cooldown.failed();
				throw error;
			}
			if (result.ok) {
				cooldown.succeeded();
				return {
					answers: result.answers,
					usage: result.usage,
					model: result.model,
					elapsedMs: result.elapsedMs,
				} as Evaluation<Q>;
			}
			cooldown.failed();
			throw new Error(`${result.code}: ${result.error}`);
		},
	};
}
