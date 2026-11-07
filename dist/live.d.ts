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
 * The unknown-call judgment (warden spec §3.2), for bash-unknown and
 * mcp-unknown alike: for bash the ask gate decides whether any answer
 * could change the outcome; the irreversible question classifies the
 * rest. Returns the resolved classification — "allow" (with the log
 * record written for the 0.5–0.9 band) or "destructive" (the flow
 * continues as destructive; an MCP call keeps its mcp pair).
 */
export declare function judgeUnknown(input: LiveInput): Promise<Classification>;
/** The pre-rename name, kept for the package's public export. */
export declare const judgeBashUnknown: typeof judgeUnknown;
/**
 * The live flow for a destructive call (spec §3.2 steps 1–5). The
 * caller guarantees a live presence; bash-unknown and mcp-unknown calls
 * pass through `judgeUnknown` first.
 */
export declare function evaluateLive(input: LiveInput): Promise<LiveOutcome>;
