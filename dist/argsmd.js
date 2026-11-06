import { redact } from "pi-warden";
/** A fence longer than any backtick run inside `text` (CommonMark). */
function fence(text, info) {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const ticks = "`".repeat(Math.max(3, longest + 1));
    return `${ticks}${info}\n${text}\n${ticks}`;
}
export function argumentsMarkdown(call) {
    const args = call.arguments;
    if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        const { command, ...rest } = args;
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
