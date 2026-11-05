/**
 * Task 14 evidence collection: the redacted tool-result texts of THIS
 * run that mention a target, newest first, within a byte budget.
 */
import { redact } from "pi-warden";
/** The default card-check evidence budget (one DecisionRequest's worth). */
export const EVIDENCE_BUDGET_BYTES = 16_384;
/** The text blocks of one entry's toolResult messages, joined. */
function toolResultText(entry) {
    const parts = [];
    for (const message of entry.model ?? []) {
        if (message.role !== "toolResult")
            continue;
        const content = message.content;
        if (typeof content === "string") {
            parts.push(content);
        }
        else if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === "object" &&
                    block !== null &&
                    block.type === "text" &&
                    typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
        }
    }
    return parts.join("\n");
}
/**
 * This run's tool-result texts mentioning any target, redacted, newest
 * first, trimmed to `budgetBytes` (an item that overflows the remaining
 * budget is dropped whole — no partial lines).
 */
export function evidenceFor(run, targets, budgetBytes) {
    const out = [];
    let remaining = budgetBytes;
    // run.entries are oldest first; evidence is newest first.
    for (let i = run.entries.length - 1; i >= 0; i -= 1) {
        const text = toolResultText(run.entries[i]);
        if (text === "")
            continue;
        if (!targets.some((target) => text.includes(target)))
            continue;
        const redacted = redact(text);
        const bytes = Buffer.byteLength(redacted, "utf8");
        if (bytes > remaining)
            continue;
        remaining -= bytes;
        out.push(redacted);
    }
    return out;
}
