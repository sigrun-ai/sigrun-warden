/**
 * The held call's arguments as markdown, for the escalation body and the
 * live confirm gate. A shell call (`arguments.command` is a string)
 * shows the command itself in a `bash` fence — real newlines, readable
 * without scrolling one JSON line sideways — and any other arguments as
 * pretty-printed JSON. Everything passes through `redact` first.
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { redact } from "pi-warden";

/** A fence longer than any backtick run inside `text` (CommonMark). */
function fence(text: string, info: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${info}\n${text}\n${ticks}`;
}

export function argumentsMarkdown(call: Pick<ToolHookCall, "arguments">): string {
	const args = call.arguments as unknown;
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const { command, ...rest } = args as Record<string, unknown>;
		if (typeof command === "string") {
			const parts = [`Command:\n${fence(redact(command), "bash")}`];
			if (Object.keys(rest).length > 0) {
				parts.push(`Other arguments:\n${fence(redact(JSON.stringify(rest, null, 2)), "json")}`);
			}
			return parts.join("\n\n");
		}
	}
	return `Arguments:\n${fence(redact(JSON.stringify(args, null, 2)), "json")}`;
}
