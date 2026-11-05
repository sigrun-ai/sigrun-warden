import { redact } from "pi-warden";
/** The human-facing body of a raised hold: tool, redacted args, reasons. */
export function escalationBody(call, reasons) {
    const redactedArgs = redact(JSON.stringify(call.arguments));
    const reasonLines = reasons.map((reason) => `- ${reason}`).join("\n");
    return `The warden held \`${call.name}\` in a job run.\n\nArguments:\n\`\`\`json\n${redactedArgs}\n\`\`\`\n\n${reasonLines}`;
}
/** One boot-scoped warning when job holds have no inbox to land in. */
let warnedNoProvider = false;
/** Test hook: reset the once-per-process no-provider warning. */
export function resetNoProviderWarning() {
    warnedNoProvider = false;
}
/**
 * Raise (or dedup) the hold as an escalation item. With no escalation
 * provider the hold still surfaces: a notice to the job's owner keyed
 * by the grant key (skipped when the job has no owner), plus one
 * console.warn per process.
 */
export async function raiseEscalation(host, call, key, jobId, owner, reasons, conversationId) {
    const body = escalationBody(call, reasons);
    const result = (await host.publishedHooks.call("escalation.raise", {
        key,
        title: `Held: ${call.name}`,
        body,
        options: [
            { id: "approve", label: "Approve and run once" },
            { id: "decline", label: "Decline" },
        ],
        allowInstruction: false,
        onAnswer: "next-run",
        jobId,
    }, { conversationId }));
    if (result.status === "absent") {
        if (!warnedNoProvider) {
            warnedNoProvider = true;
            console.warn("warden: no escalation provider; job holds have no inbox (surface via notices)");
        }
        if (owner !== undefined) {
            await host.notices.post({
                user: owner,
                key,
                title: `Held: ${call.name}`,
                body,
                tone: "warn",
            });
        }
        return { status: "absent" };
    }
    const ok = result;
    return { status: ok.status, id: ok.id, created: ok.created };
}
/** Claim an answered item for the calling conversation (or report none). */
export async function takeGrant(host, key, jobId, conversationId) {
    const result = (await host.publishedHooks.call("escalation.take", { key, jobId }, { conversationId }));
    // A missing provider answers `absent`; that is NOT a grant in a
    // non-approving state (the caller's `!== "none"` gate would read it as
    // one and never reach the clearance path — the Task 16 e2e regression).
    // Absence maps to `none`: no inbox, no grant, keep going.
    if (result.status === "absent")
        return { status: "none" };
    return {
        status: result.status,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.option === undefined ? {} : { option: result.option }),
    };
}
/** Resolve a claimed item after carrying out its answer. */
export async function resolveGrant(host, id, outcome, note, conversationId) {
    const result = (await host.publishedHooks.call("escalation.resolve", { id, outcome, note }, { conversationId }));
    return { status: result.status };
}
