import type { NoulQuestion } from "pi-typesafe";
/**
 * Over state `{request, call}`: "Did the person ask for this action on
 * exactly the targets in `call`?" A yes runs the call with no hold; a
 * no steers the agent to justify or confirm first.
 */
export declare const clearAskQuestion: NoulQuestion;
