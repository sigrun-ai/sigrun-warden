import type { Judge } from "pi-typesafe";
import type { Classification } from "./classify.js";
import type { Cooldown } from "./judge.js";
import type { RouteInput } from "./route.js";
export interface LiveInput extends RouteInput {
    /** The decisions judge; `undefined` when disabled or in cooldown. */
    judge: Judge | undefined;
    cooldown: Cooldown;
}
export type LiveOutcome = {
    action: "run";
} | {
    action: "steer";
    text: string;
} | {
    action: "ask-person";
};
/**
 * The bash-unknown judgment (warden spec §3.2): the ask gate decides
 * whether any answer could change the outcome; the irreversible
 * question classifies the rest. Returns the resolved classification —
 * "allow" (with the log record written for the 0.5–0.9 band) or
 * "destructive" (the flow continues as destructive).
 */
export declare function judgeBashUnknown(input: LiveInput): Promise<Classification>;
/**
 * The live flow for a destructive call (spec §3.2 steps 1–5). The
 * caller guarantees a live presence; bash-unknown calls pass through
 * `judgeBashUnknown` first.
 */
export declare function evaluateLive(input: LiveInput): Promise<LiveOutcome>;
