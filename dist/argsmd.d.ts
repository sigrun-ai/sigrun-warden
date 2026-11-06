/**
 * The held call's arguments as markdown, for the escalation body and the
 * live confirm gate. A shell call (`arguments.command` is a string)
 * shows the command itself in a `bash` fence — real newlines, readable
 * without scrolling one JSON line sideways — and any other arguments as
 * pretty-printed JSON. Everything passes through `redact` first.
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
export declare function argumentsMarkdown(call: Pick<ToolHookCall, "arguments">): string;
