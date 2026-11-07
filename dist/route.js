import { randomBytes } from "node:crypto";
import { redact } from "pi-warden";
import { cardCheck } from "./card-check.js";
import { buildCard } from "./cards.js";
import { EVIDENCE_BUDGET_BYTES, evidenceFor } from "./evidence.js";
import { holdForPerson } from "./interaction.js";
import { raiseEscalation, resolveGrant, takeGrant } from "./escalate.js";
import { skillsInRun } from "./skills.js";
import { callFingerprint, grantKey } from "./state.js";
import { targetsOf } from "./targets.js";
import { Cooldown } from "./judge.js";
import { evaluateLive, judgeUnknown } from "./live.js";
/** Collision-impossible live-hold nonce (6 random bytes as hex). */
const newNonce = () => randomBytes(6).toString("hex");
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
    const fp = callFingerprint(call);
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
    if (classification.kind !== "destructive" &&
        classification.kind !== "bash-unknown" &&
        classification.kind !== "mcp-unknown") {
        // Allowed calls still record their warn rules (classification.warns).
        if (classification.warns !== undefined && classification.warns.length > 0) {
            await input.log.append({
                ...callLog(input, logBase),
                at: new Date().toISOString(),
                action: "warn",
            });
        }
        return undefined;
    }
    const reasons = classification.kind === "bash-unknown"
        ? [`unrecognized shell command: ${classification.command}`]
        : classification.kind === "mcp-unknown"
            ? [classification.reason]
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
    // Live presence: the Task 12 flow (clear ask, steer, approval on
    // reply, bash-unknown / mcp-unknown). Destructive calls go through it
    // only with a judge; the unknown kinds always do (judge-absent is
    // pi-warden's
    // offline allow). An "ask the person" outcome — or a judge-free
    // destructive call — takes the Task 11 interaction hold.
    if (presence.kind === "live" &&
        (classification.kind === "bash-unknown" ||
            classification.kind === "mcp-unknown" ||
            input.judge !== undefined)) {
        const outcome = await evaluateLive({
            ...input,
            judge: input.judge,
            cooldown: input.cooldown ?? new Cooldown(),
        });
        if (outcome.action === "run")
            return undefined;
        if (outcome.action === "steer")
            return { block: outcome.text };
        // "ask-person" falls through to the interaction hold below.
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
                const next = newNonce();
                state.blocked.push({ fingerprint: fp, at: nowIso, afterEntry: next, status: "pending" });
                return { nonce: next, newHold: true };
            }
            if (record.status === "answered" || record.status === "released") {
                // The previous question was consumed by an answer: rotate for a
                // FRESH card. An already-released one-shot allow never frees a
                // second call.
                const next = newNonce();
                record.at = nowIso;
                record.afterEntry = next;
                record.status = "pending";
                state.released = state.released.filter((entry) => entry.fingerprint !== fp);
                return { nonce: next, newHold: true };
            }
            return { nonce: record.afterEntry ?? (record.afterEntry = newNonce()), newHold: false };
        });
        const outcome = await holdForPerson(input.host, call, input.conversationId, `${fp}-${decision.nonce}`, reasons, input.context);
        return finishAnswer(input, fp, decision.nonce, logBase, outcome);
    }
    // Job presence: an unannotated MCP call is judged for irreversibility
    // first (no judge or a failed judgment fails closed into the
    // destructive path); a reversible one runs with no escalation.
    if (classification.kind === "mcp-unknown") {
        const resolved = await judgeUnknown({
            ...input,
            judge: input.cooldown?.active === true ? undefined : input.judge,
            cooldown: input.cooldown ?? new Cooldown(),
        });
        if (resolved.kind !== "destructive")
            return undefined;
        return jobRoute({ ...input, classification: resolved }, fp, key, resolved.reasons, logBase);
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
            // Lost the claim race: the sibling already consumed this card.
            // BLOCK rather than re-poll the answered record (that hot-spins
            // two disk-writing store.updates per iteration until cancel —
            // the I-1 livelock). Exactly-one-release is preserved: the model
            // retries after the sibling settles and gets a fresh card.
            return { block: "an identical call is already awaiting approval" };
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
        // A co-waiter already consumed this deny: same lost-claim block,
        // never a spin.
        return { block: "an identical call is already awaiting approval" };
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
            // 'own' requires a REAL grant: an empty placeholder slot (pushed
            // before the take ran) is NOT a reservation — a re-entered call
            // whose take never landed must decide/take again, never run on
            // the placeholder alone (the C-1 fail-open hole).
            if (reserved.escalationId !== "") {
                return { kind: "own", escalationId: reserved.escalationId };
            }
            return { kind: "decide", hasSlot: true };
        }
        return { kind: "decide", hasSlot: false };
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
    // reservation. A re-entry onto its OWN empty placeholder keeps that
    // slot (it serializes against siblings) but takes fresh.
    if (!decision.hasSlot) {
        await input.store.update(input.conversationId, (state) => {
            state.reservations.push({ grantKey: key, callId: call.id, escalationId: "" });
        });
    }
    let taken;
    try {
        taken = await takeGrant(input.host, key, presence.jobId, input.conversationId);
    }
    catch (error) {
        // A thrown take must not leak the placeholder: clear the slot so
        // the key isn't wedged as 'contended' for the rest of the run.
        await input.store.update(input.conversationId, (state) => {
            state.reservations = state.reservations.filter((entry) => !(entry.grantKey === key && entry.callId === call.id));
        });
        throw error;
    }
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
    if (taken.status !== "none") {
        // A grant exists in a non-approving state (open, answered-deny):
        // it decides before the clearance path (brief step 1: the grant
        // check first, unchanged from Task 11). Release this call's slot
        // first, then take the block + raise path (the raise dedups onto
        // the EXISTING item, so no duplicate).
        //
        // NOTE: `absent` (no escalation provider) is NOT a grant: a
        // cleared call must not be shadowed by a missing inbox. `takeGrant`
        // maps the registry's `absent` to `none` (Task 16 e2e regression).
        await input.store.update(input.conversationId, (state) => {
            state.reservations = state.reservations.filter((entry) => !(entry.grantKey === key && entry.callId === call.id));
        });
        return jobRaise(input, reasons, logBase);
    }
    // Task 14: a call CLEARED for this job + tool may run autonomously,
    // but only after the per-target card check. The clearance is a
    // settings entry (`{job, tools}`) — never a skill. Everything else
    // keeps the Task 11 block + escalate path below.
    const cleared = input.settings.clearances.some((clearance) => clearance.job === presence.jobId && clearance.tools.includes(call.name));
    if (cleared) {
        // The card-check path does not use the grant reservation: release
        // the placeholder slot before judging.
        await input.store.update(input.conversationId, (state) => {
            state.reservations = state.reservations.filter((entry) => !(entry.grantKey === key && entry.callId === call.id));
        });
        return clearedJobRoute(input, reasons, logBase);
    }
    return jobRaise(input, reasons, logBase);
}
/**
 * The Task 11 tail: raise (idempotent by grant key) and block. Split
 * out so jobRoute's post-grant no-grant exit can share it.
 */
async function jobRaise(input, reasons, logBase) {
    const { presence, call } = input;
    if (presence.kind !== "job")
        throw new Error("jobRaise in a non-job presence");
    const key = grantKey(call.name, call.arguments);
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
    const id = raised.id;
    if (id === undefined) {
        // No item: name why (no inbox vs a failing inbox) and the reasons.
        return {
            block: `Not cleared for this job without a person's approval; ${noItemReason(raised)}. Reasons: ${reasons.join("; ")}`,
        };
    }
    return {
        block: `Not cleared for this job without a person's approval; raised escalation ${id}.`,
    };
}
/** Why a raise produced no inbox item, for the block text. */
function noItemReason(raised) {
    return raised.status === "absent"
        ? "no escalation inbox is installed"
        : `the escalation could not be raised (${raised.error ?? raised.status})`;
}
const MAX_TARGETS = 16;
/**
 * The cleared-job path (Task 14, brief order): a cleared destructive
 * call runs autonomously only after a per-target card check against the
 * decision model. Every failure mode blocks + escalates — never runs.
 */
async function clearedJobRoute(input, reasons, logBase) {
    const { call, presence } = input;
    if (presence.kind !== "job")
        throw new Error("clearedJobRoute outside a job presence");
    const blockEscalate = async (block, escalateReasons) => {
        const raised = await raiseEscalation(input.host, call, grantKey(call.name, call.arguments), presence.jobId, presence.owner, escalateReasons, input.conversationId);
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "escalate",
            outcome: "escalated",
        });
        if (raised.id === undefined) {
            return {
                block: `${block}; ${noItemReason(raised)}. Reasons: ${escalateReasons.join("; ")}`,
            };
        }
        return { block: `${block}; raised escalation ${raised.id}.` };
    };
    // 1. No decision model (undefined judge, or the cooldown active →
    // decisionsJudge returned undefined upstream; a thrown judgment →
    // unjudgeable below). All no-model outcomes block + escalate.
    const coolingDown = input.cooldown?.active === true;
    if (input.judge === undefined || coolingDown) {
        return blockEscalate(`Not running ${call.name} autonomously: no decision model available`, [...reasons, "no decision model available"]);
    }
    // 2. A tainted run never runs autonomously this run.
    const state = await input.store.load(input.conversationId);
    if (state.tainted === true) {
        return blockEscalate(`Not running ${call.name} autonomously: instructions found in tool output this run`, [...reasons, "instructions found in tool output this run"]);
    }
    // 3. Over 16 targets: steer the split, no decision request.
    const targets = targetsOf(call.arguments);
    if (targets.length > MAX_TARGETS) {
        return blockEscalate(`Not running ${call.name} autonomously: too many targets (${targets.length}); split this into calls of at most ${MAX_TARGETS} targets`, [...reasons, "too many targets"]);
    }
    // 4. The governing cards: those of skillsInRun whose text names the
    // tool's mcpName or sigrun name. A missing card may be built inline.
    const skills = skillsInRun(input.run.entries);
    const cards = [];
    for (const skill of skills) {
        const card = await buildCard(input.host, skill, input.settings);
        if (card === undefined)
            continue;
        cards.push(card);
    }
    const names = [input.classification.kind === "destructive" ? input.classification.mcp?.mcpName : undefined, call.name].filter((name) => name !== undefined);
    const governing = cards.filter((card) => names.some((name) => card.text.includes(name)));
    const displayName = input.classification.kind === "destructive" && input.classification.mcp !== undefined
        ? input.classification.mcp.mcpName
        : call.name;
    if (governing.length === 0) {
        return blockEscalate(`Not running ${call.name} autonomously: no skill card covers ${displayName}`, [...reasons, `no skill card covers ${displayName}`]);
    }
    // 5. The card check.
    const outcome = await cardCheck({
        judge: input.judge,
        cards: governing,
        call,
        ...(input.classification.kind === "destructive" &&
            input.classification.mcp !== undefined
            ? { mcpName: input.classification.mcp.mcpName }
            : {}),
        targets,
        evidence: evidenceFor(input.run, targets, EVIDENCE_BUDGET_BYTES),
        threshold: input.settings.thresholds.card,
    });
    if (outcome.pass === true) {
        await input.log.append({
            ...callLog(input, logBase),
            at: new Date().toISOString(),
            action: "allow-judged",
            scores: outcome.scores,
        });
        return undefined;
    }
    if (outcome.pass === "unjudgeable") {
        return blockEscalate(`Not running ${call.name} autonomously: no decision model available (${outcome.reason})`, [...reasons, `no decision model available (${outcome.reason})`]);
    }
    return blockEscalate(`Not running ${call.name} autonomously: the card check failed for ${outcome.failing.join(", ")} (${outcome.reasons.join("; ")})`, [...reasons, ...outcome.reasons]);
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
