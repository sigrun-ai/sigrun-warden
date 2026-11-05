import { redact } from "pi-warden";
import { holdForPerson } from "./interaction.js";
import { raiseEscalation, resolveGrant, takeGrant } from "./escalate.js";
import { grantKey } from "./state.js";
/** The fingerprint of one call: the grant key WITHOUT the `warden:` prefix. */
function fingerprint(call) {
    return grantKey(call.name, call.arguments).slice("warden:".length);
}
function callLog(input, base) {
    const presence = input.presence;
    return {
        ...base,
        ...(presence.kind === "job" ? { jobId: presence.jobId } : {}),
        ...("owner" in presence && presence.owner !== undefined
            ? { owner: presence.owner }
            : {}),
        call: redact(JSON.stringify(input.call.arguments)),
    };
}
/**
 * Route one classified call. Returns `{block}` to block, undefined to
 * allow. Nested calls (`call.parent` set — codemode/executeTool) route
 * EXACTLY like model-issued calls: no special-casing.
 */
export async function routeOffline(input) {
    const { classification, presence, call } = input;
    const fp = fingerprint(call);
    const key = grantKey(call.name, call.arguments);
    const logBase = {
        conversationId: input.conversationId,
        tool: call.name,
    };
    // A deny classification blocks in every presence.
    if (classification.kind === "deny") {
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "block",
            outcome: "declined",
        });
        await input.store.update(input.conversationId, (state) => {
            state.tainted = true;
        });
        return { block: classification.reason };
    }
    if (classification.kind !== "destructive" && classification.kind !== "bash-unknown") {
        // Allowed calls still record their warn rules (classification.warns).
        if (classification.warns !== undefined && classification.warns.length > 0) {
            const reasons = classification.warns.join("; ");
            await input.log.append({
                ...callLog(input, logBase),
                at: new Date().toISOString(),
                action: "warn",
            });
            void reasons;
        }
        return undefined;
    }
    const reasons = classification.kind === "bash-unknown"
        ? [`unrecognized shell command: ${classification.command}`]
        : classification.reasons;
    // Internal (curator) presence: block outright, no escalation.
    if (presence.kind === "internal") {
        const reason = reasons.join("; ");
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "block",
            outcome: "declined",
        });
        return { block: `This call can't run in a curator review: ${reason}` };
    }
    // Live presence: an interaction question per fingerprint.
    //
    // Consumption design (fail-closed, see the task report): interaction
    // records are seeded first-write-wins and nothing re-pends an ANSWERED
    // record, so ONE answered record must never release more than one call.
    // The store therefore pins a per-hold NONCE in the blocked record
    // (`afterEntry`): the interaction callId is `warden-<fp>-<nonce>`. A
    // re-entered beforeTool (same fingerprint, nonce unchanged) waits on
    // the SAME record; once an answer is consumed (allow released one call,
    // or deny blocked it), the next beforeTool for the fingerprint rotates
    // the nonce, seeding a FRESH card. One answered card can never release
    // two calls, and a denied retry can't be silently allowed by the stale
    // answer.
    if (presence.kind === "live") {
        const nowIso = new Date().toISOString();
        // One store.update registers the hold (or rotates it once an
        // answer is consumed) so re-entries and new-callId retries join the
        // same question.
        const decision = await input.store.update(input.conversationId, (state) => {
            if (state.runStart !== input.run.runStart) {
                state.runStart = input.run.runStart;
                state.steers = 0;
                state.tainted = undefined;
            }
            const record = state.blocked.find((entry) => entry.fingerprint === fp);
            if (record === undefined) {
                const next = Math.random().toString(16).slice(2, 8);
                state.blocked.push({ fingerprint: fp, at: nowIso, afterEntry: next, status: "pending" });
                return { nonce: next, newHold: true };
            }
            if (record.status === "answered" || record.status === "released") {
                // The previous question was consumed by an answer: rotate for a
                // FRESH card. An already-released one-shot allow never frees a
                // second call.
                const next = Math.random().toString(16).slice(2, 8);
                record.at = nowIso;
                record.afterEntry = next;
                record.status = "pending";
                state.released = state.released.filter((entry) => entry.fingerprint !== fp);
                return { nonce: next, newHold: true };
            }
            return { nonce: record.afterEntry ?? (record.afterEntry = Math.random().toString(16).slice(2, 8)), newHold: false };
        });
        const outcome = await holdForPerson(input.host, call, input.conversationId, `${fp}-${decision.nonce}`, reasons, input.context);
        return finishAnswer(input, fp, decision.nonce, logBase, outcome);
    }
    // Job presence: block + escalate with one-shot grants.
    return jobRoute(input, fp, key, reasons, logBase);
}
async function finishAnswer(input, fp, nonce, logBase, outcome) {
    const { call } = input;
    if (outcome.answer === "allow") {
        // The FIRST waiter to claim the answer releases; every other
        // waiter on the same card re-waits on the CURRENT hold.
        const released = await input.store.update(input.conversationId, (state) => {
            const record = state.blocked.find((entry) => entry.fingerprint === fp);
            // Another waiter already consumed this answer (or the hold was
            // rotated while we were polling): this call is not released by it.
            if (record === undefined || record.status !== "pending")
                return false;
            record.status = "released";
            state.released.push({ fingerprint: fp, replyEntry: `${call.id}:${nonce}` });
            return true;
        });
        if (!released) {
            return waitCurrentHold(input, fp, logBase);
        }
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "release",
            outcome: "approved",
        });
        return undefined;
    }
    const reason = outcome.reason === "" ? "denied by the answering person" : outcome.reason;
    const first = await input.store.update(input.conversationId, (state) => {
        const record = state.blocked.find((entry) => entry.fingerprint === fp);
        if (record !== undefined && record.status === "pending") {
            record.status = "answered";
            return true;
        }
        return false;
    });
    if (!first) {
        // A co-waiter already consumed this deny; keep waiting on the
        // current hold (a deny is per-hold, so a fresh card is asked).
        return waitCurrentHold(input, fp, logBase);
    }
    await input.log.append({
        ...callLog(input, logBase),
        at: new Date().toISOString(),
        action: "block",
        outcome: "declined",
    });
    return { block: `Held ${call.name} denied: ${reason}` };
}
/**
 * Re-wait after a lost consumption race: resolve the CURRENT hold nonce
 * for the fingerprint (rotated by the winner's next call or unchanged
 * while pending) and poll it. Rotation is marked `answered` between the
 * claimer's finish and the next beforeTool's rotation; treat that as
 * pending-with-the-stale-answer-consumed, i.e. keep waiting on the same
 * nonce until the next beforeTool rotates it (its poll then seeds a
 * fresh card, which is the fresh question this waiter should observe —
 * simplest correct behavior: wait the CURRENT nonce and let the
 * rotation's fresh card answer it).
 */
async function waitCurrentHold(input, fp, logBase) {
    const nonce = await input.store.update(input.conversationId, (state) => {
        const record = state.blocked.find((entry) => entry.fingerprint === fp);
        if (record === undefined)
            return undefined;
        return record.afterEntry;
    });
    if (nonce === undefined)
        return { block: "warden error: hold state lost" };
    const outcome = await holdForPerson(input.host, input.call, input.conversationId, `${fp}-${nonce}`, [], // reasons already on the seeded card
    input.context);
    return finishAnswer(input, fp, nonce, logBase, outcome);
}
/**
 * The job-presence slice. Everything that decides allow/block runs
 * inside ONE store.update so parallel identical calls serialize.
 */
async function jobRoute(input, fp, key, reasons, logBase) {
    const { presence, call, run } = input;
    if (presence.kind !== "job")
        throw new Error("jobRoute in a non-job presence");
    // A reservation whose call never ran is dropped by the escalations
    // run-end sweep; here warden only drops reservations from older runs.
    const decision = await input.store.update(input.conversationId, (state) => {
        if (state.runStart !== run.runStart) {
            const startingNewRun = state.runStart !== undefined && run.runStart !== undefined;
            state.runStart = run.runStart;
            state.steers = 0;
            state.tainted = undefined;
            if (startingNewRun) {
                // Reservations from an EARLIER run are stale (the sweep owns
                // their escalation item; keeping them would confuse a
                // restarted run). Within one run (same runStart), or before
                // the first user entry, nothing is dropped.
                state.reservations = state.reservations.filter(() => false);
            }
        }
        const reserved = state.reservations.find((entry) => entry.grantKey === key);
        // Only real (escalation-backed) reservations make a sibling call
        // 'dup'; an EMPTY slot (take/takeGrant still in flight) must wait
        // its turn, not block as a duplicate.
        if (reserved !== undefined && reserved.escalationId !== "" && reserved.callId !== call.id) {
            return { kind: "dup" };
        }
        if (reserved !== undefined && reserved.escalationId === "" && reserved.callId !== call.id) {
            // A sibling is being decided; ask it to yield to this caller so
            // this caller does not ALSO take/raise (double grant).
            return { kind: "contended" };
        }
        if (reserved !== undefined) {
            return { kind: "own", escalationId: reserved.escalationId };
        }
        return { kind: "decide" };
    });
    if (decision.kind === "dup") {
        return { block: "an identical call is already running under this approval" };
    }
    if (decision.kind === "own") {
        return undefined; // re-entered with the same call id — still allowed
    }
    if (decision.kind === "contended") {
        // A sibling's take/raise is in flight; wait for it to settle.
        // Poll the store until the sibling's slot either resolves to a
        // real reservation (this caller is then 'dup') or disappears
        // (its raise failed; this caller decides). Bounded so a stuck
        // sibling cannot spin this waiter forever.
        for (let spins = 0; spins < 200; spins += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const sibling = await input.store.update(input.conversationId, (state) => state.reservations.find((entry) => entry.grantKey === key && entry.callId !== call.id));
            if (sibling === undefined)
                return jobRoute(input, fp, key, reasons, logBase);
            if (sibling.escalationId !== "") {
                return { block: "an identical call is already running under this approval" };
            }
        }
        return { block: "warden error: a sibling hold never settled" };
    }
    // Only ONE unreserved call per grant key proceeds past this line;
    // claim a slot IN THE STORE before hitting the escalation hooks so
    // parallel identical calls serialize (the brief's rule). A slot whose
    // escalation id never lands (take didn't yield a grant) is removed
    // below; one whose call never runs is left for the sweep like a real
    // reservation.
    await input.store.update(input.conversationId, (state) => {
        state.reservations.push({ grantKey: key, callId: call.id, escalationId: "" });
    });
    const taken = await takeGrant(input.host, key, presence.jobId, input.conversationId);
    if (taken.status === "claimed" && taken.option === "approve" && taken.id !== undefined) {
        // Swap the slot's placeholder for the real item id.
        await input.store.update(input.conversationId, (state) => {
            const reservation = state.reservations.find((entry) => entry.grantKey === key && entry.callId === call.id);
            if (reservation !== undefined)
                reservation.escalationId = taken.id;
        });
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "release",
            outcome: "approved",
        });
        return undefined;
    }
    // No usable grant: if a sibling is still deciding this key, wait for
    // its outcome — a granted sibling makes this call 'dup', a raised one
    // makes this call block with the same item. Bounded.
    for (let spins = 0;; spins += 1) {
        const sibling = await input.store.update(input.conversationId, (state) => state.reservations.find((entry) => entry.grantKey === key && entry.callId !== call.id));
        if (sibling === undefined)
            break; // no sibling: this call raises below
        if (sibling.escalationId !== "") {
            // The sibling's grant landed; drop this call's slot and block dup.
            await input.store.update(input.conversationId, (state) => {
                state.reservations = state.reservations.filter((entry) => !(entry.grantKey === key && entry.callId === call.id));
            });
            return { block: "an identical call is already running under this approval" };
        }
        if (spins >= 200) {
            return { block: "warden error: a sibling hold never settled" };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // No usable grant: release the slot, raise (idempotent by key), block.
    await input.store.update(input.conversationId, (state) => {
        state.reservations = state.reservations.filter((entry) => !(entry.grantKey === key && entry.callId === call.id));
    });
    // No usable grant: raise (idempotent by grant key) and block.
    const raised = await raiseEscalation(input.host, call, key, presence.jobId, presence.owner, reasons, input.conversationId);
    await input.log.append({
        ...callLog(input, logBase),
        at: new Date().toISOString(),
        action: "escalate",
        outcome: "escalated",
    });
    const id = raised.id ?? "unknown";
    return {
        block: `Not cleared for this job without a person's approval; raised escalation ${id}.`,
    };
}
/**
 * The Task-11 slice of afterTool: resolve the grant this call's
 * reservation names and drop the reservation. The planted-instructions /
 * masking / stuck guards are Task 15 and are omitted here entirely.
 */
export async function resolveReservedGrant(input) {
    const key = grantKey(input.call.name, input.call.arguments);
    const reservation = await input.store.update(input.conversationId, (state) => {
        const index = state.reservations.findIndex((entry) => entry.grantKey === key && entry.callId === input.call.id);
        if (index < 0)
            return undefined;
        const [found] = state.reservations.splice(index, 1);
        return found;
    });
    if (reservation === undefined)
        return;
    const failed = input.result.isError === true;
    try {
        await resolveGrant(input.host, reservation.escalationId, failed ? "failed" : "done", failed ? "warden: the call failed" : "warden: executed", input.conversationId);
    }
    catch (error) {
        console.warn(`warden: resolving grant ${reservation.escalationId} failed`, error);
    }
}
/** One background prune per process, never awaited by the hook. */
let pruneStarted = false;
/** Test hook: reset the once-per-process prune guard. */
export function resetPruneGuardForTests() {
    pruneStarted = false;
}
/** Kick `log.prune` exactly once per process; failures go to console.warn. */
export function startPruneOnce(log, retentionDays) {
    if (pruneStarted)
        return;
    pruneStarted = true;
    void log
        .prune(retentionDays)
        .catch((error) => console.warn("warden: hold-log prune failed", error));
}
