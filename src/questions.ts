/**
 * The warden's own decision questions (Task 12). pi-warden's question
 * set lives in pi-warden's `questions` export; these are the ones the
 * sigrun live path adds. `clearAskQuestion` is asked over the state
 * `{request, call}` where `request` is the person's most recent request
 * (redacted, last 3000 chars) and `call` is the redacted JSON of the
 * tool arguments.
 */
import { noul } from "pi-typesafe";
import type { NoulQuestion } from "pi-typesafe";

/**
 * Over state `{request, call}`: "Did the person ask for this action on
 * exactly the targets in `call`?" A yes runs the call with no hold; a
 * no steers the agent to justify or confirm first.
 */
export const clearAskQuestion: NoulQuestion = noul(
	"Did the person ask for this action on exactly the targets in `call`? `request` is the person's most recent message; `call` is the tool call about to run. The call must do exactly what the request names — the same action on the same targets. A request that names different targets, a broader or narrower set, or only a vague goal without these targets does not count.",
	{
		true: "Yes: the request explicitly asks for this action on exactly the targets in `call` (the targets named in the request match the call's targets).",
		false: "No: the request names different targets, only gestures at a goal without naming these targets, or the call goes beyond or short of what was asked.",
	},
);
