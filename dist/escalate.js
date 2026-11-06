import { argumentsMarkdown } from "./argsmd.js";
/** The human-facing body of a raised hold: tool, redacted args, reasons. */
export function escalationBody(call, reasons) {
    const reasonLines = reasons.map((reason) => `- ${reason}`).join("\n");
    return `The warden held \`${call.name}\` in a job run.\n\n${argumentsMarkdown(call)}\n\n${reasonLines}`;
}
/** One boot-scoped warning when job holds have no inbox to land in. */
let warnedNoProvider = false;
/** Test hook: reset the once-per-process no-provider warning. */
export function resetNoProviderWarning() {
    warnedNoProvider = false;
}
/**
 * Unwrap the registry envelope: a provider's return value rides in
 * `value` under status `ok`; `absent` means no provider; `rejected` /
 * `failed` carry a reason. Never read provider fields off the envelope
 * itself (0.1.1 did, so every raise looked inbox-less and every take
 * looked like a non-approving grant).
 */
function unwrap(result) {
    const envelope = result;
    if (envelope.status === "absent")
        return { kind: "absent" };
    if (envelope.status === "ok") {
        const value = envelope.value;
        if (typeof value === "object" && value !== null) {
            return { kind: "ok", value: value };
        }
        return { kind: "error", message: "the escalation provider returned no object" };
    }
    if (envelope.status === "rejected") {
        return {
            kind: "error",
            message: `rejected: ${envelope.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`,
        };
    }
    if (envelope.status === "failed") {
        return {
            kind: "error",
            message: `failed (${envelope.reason})${envelope.error === undefined ? "" : `: ${envelope.error}`}`,
        };
    }
    return { kind: "error", message: `unexpected hook status ${String(envelope.status)}` };
}
const str = (value) => typeof value === "string" ? value : undefined;
/**
 * Raise (or dedup) the hold as an escalation item. With no escalation
 * provider the hold still surfaces: a notice to the job's owner keyed
 * by the grant key (skipped when the job has no owner), plus one
 * console.warn per process. A provider that rejects or fails yields no
 * id and an `error` naming why.
 */
export async function raiseEscalation(host, call, key, jobId, owner, reasons, conversationId) {
    const body = escalationBody(call, reasons);
    const result = unwrap(await host.publishedHooks.call("escalation.raise", {
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
    if (result.kind === "absent") {
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
    if (result.kind === "error") {
        console.warn(`warden: raising escalation ${key} ${result.message}`);
        return { status: "error", error: result.message };
    }
    const id = str(result.value.id);
    const created = result.value.created;
    return {
        status: str(result.value.status) ?? "open",
        ...(id === undefined ? {} : { id }),
        ...(typeof created === "boolean" ? { created } : {}),
    };
}
/**
 * Claim an answered item for the calling conversation (or report none).
 * A missing provider is `none` (no inbox, no grant, keep going); a
 * provider error is `error` — never `none`, so the caller fails closed
 * (raise + block) instead of reaching the clearance path.
 */
export async function takeGrant(host, key, jobId, conversationId) {
    const result = unwrap(await host.publishedHooks.call("escalation.take", { key, jobId }, { conversationId }));
    // A missing provider answers `absent`; that is NOT a grant in a
    // non-approving state (the caller's `!== "none"` gate would read it as
    // one and never reach the clearance path — the Task 16 e2e regression).
    if (result.kind === "absent")
        return { status: "none" };
    if (result.kind === "error") {
        console.warn(`warden: taking grant ${key} ${result.message}`);
        return { status: "error" };
    }
    const id = str(result.value.id);
    const option = str(result.value.option);
    return {
        status: str(result.value.status) ?? "error",
        ...(id === undefined ? {} : { id }),
        ...(option === undefined ? {} : { option }),
    };
}
/** Resolve a claimed item after carrying out its answer (throws on a provider error). */
export async function resolveGrant(host, id, outcome, note, conversationId) {
    const result = unwrap(await host.publishedHooks.call("escalation.resolve", { id, outcome, note }, { conversationId }));
    if (result.kind === "absent")
        return { status: "absent" };
    if (result.kind === "error")
        throw new Error(`escalation.resolve ${result.message}`);
    return { status: str(result.value.status) ?? "resolved" };
}
