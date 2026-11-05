const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Session-scoped pause on a failing judge: three consecutive failures
 * pause judgment calls for five minutes. Nothing is persisted; a new
 * process starts with the judge trusted again.
 */
export class Cooldown {
    #now;
    #failures = 0;
    #until = 0;
    /** The default reads Date.now on each call, so a test can mock the clock. */
    constructor(now = () => Date.now()) {
        this.#now = now;
    }
    /** Record one judge failure; the third consecutive one opens the window. */
    failed() {
        this.#failures += 1;
        if (this.#failures >= FAILURE_LIMIT) {
            this.#until = this.#now() + COOLDOWN_MS;
        }
    }
    /** A successful judgment clears the streak and the window. */
    succeeded() {
        this.#failures = 0;
        this.#until = 0;
    }
    /** True while judgments are paused. */
    get active() {
        return this.#until > this.#now();
    }
}
/**
 * The judge for one settings snapshot: `undefined` when the judge is
 * disabled or the cooldown is active. The evaluate implementation:
 *
 * - calls `host.decisions.evaluate(request, {model: settings.decisionModel, signal})`;
 * - on `ok:true` returns the RAW Evaluation shape `{answers, usage, model, elapsedMs}`;
 * - on `ok:false` throws `Error("<code>: <error>")` so pi-warden's and
 *   our ask paths see a failure;
 * - every outcome updates the cooldown (thrown transport errors count
 *   as failures too).
 */
export function decisionsJudge(host, settings, cooldown) {
    if (!settings.judge.enabled)
        return undefined;
    if (cooldown.active)
        return undefined;
    return {
        evaluate: async (request, options) => {
            let result;
            try {
                result = await host.decisions.evaluate(request, {
                    model: settings.decisionModel,
                    signal: options?.signal,
                });
            }
            catch (error) {
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
                };
            }
            cooldown.failed();
            throw new Error(`${result.code}: ${result.error}`);
        },
    };
}
