/**
 * The live-path decision flow (warden spec §3.2, Task 12): the
 * destructive-call judgment — clear ask → run, vague ask → steer,
 * approval on reply, ignored steer → ask the person — and the
 * bash-unknown irreversible judgment. Everything here returns an
 * outcome; `route.ts` maps it onto block text / the interaction hold.
 */
import { APPROVAL_THRESHOLD, actionAskGate, askApproval, describeAction, questions, redact, stripDataText, } from "pi-warden";
import { clearAskQuestion } from "./questions.js";
import { callFingerprint } from "./state.js";
/** The approval request's own deadline (pi-warden's default shape). */
const APPROVAL_TIMEOUT_MS = 30_000;
/** The steer wording is unconditional: a hook can't see the tool list. */
function vagueSteerText(tool) {
    return `Your request didn't name these targets. Say why you picked them, or confirm with the person before running ${tool} (with ask_user_question if you have it).`;
}
/** The non-approval steer: the reply did not cover this call. */
function notApprovedSteerText(tool) {
    return `The person's reply doesn't approve ${tool} on these targets; ask again or drop it.`;
}
/** The visible text of one reply entry (person message or ask tool result). */
function replyText(entry) {
    const parts = [];
    for (const message of entry.model ?? []) {
        if (message.role !== "user" && message.role !== "toolResult")
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
 * A reply entry is a person's input entry (`pi.user`, this run or a
 * later one — a later person's message IS this run's start, so the run
 * window covers both) or a tool result of a tool named
 * `ask_user_question`. Only entries AFTER the block (the blocked
 * record's `atEntry`) count.
 */
function findReply(entries, atEntry, released, fingerprint) {
    const after = atEntry === undefined ? -1 : Number(atEntry);
    for (const entry of entries) {
        const id = Number(entry.id);
        if (Number.isFinite(after) && id <= after)
            continue;
        // A reply already consumed by one release never releases another call.
        if (released.some((rel) => rel.fingerprint === fingerprint && rel.replyEntry === String(entry.id))) {
            continue;
        }
        if (entry.kind === "pi.user") {
            return { id: String(entry.id), text: replyText(entry) };
        }
        if (entry.kind === "pi.tool-result") {
            const message = (entry.model ?? [])[0];
            if (message?.toolName === "ask_user_question") {
                return { id: String(entry.id), text: replyText(entry) };
            }
        }
    }
    return undefined;
}
/**
 * The bash-unknown judgment (warden spec §3.2): the ask gate decides
 * whether any answer could change the outcome; the irreversible
 * question classifies the rest. Returns the resolved classification —
 * "allow" (with the log record written for the 0.5–0.9 band) or
 * "destructive" (the flow continues as destructive).
 */
export async function judgeBashUnknown(input) {
    const { classification } = input;
    if (classification.kind !== "bash-unknown")
        return classification;
    const command = classification.command;
    const gate = actionAskGate(input.call.name, input.call.arguments, stripDataText(command).text, "/");
    if (!gate.ask)
        return { kind: "allow", reason: gate.why };
    const destructive = {
        kind: "destructive",
        reasons: [
            `unrecognized shell command: ${command}`,
            "the decision model judged it irreversible",
        ],
    };
    // No judge: live allows (pi-warden's offline behaviour — the floor
    // caught the patterns); a job fails closed into the destructive path.
    if (input.judge === undefined) {
        if (input.presence.kind === "job")
            return destructive;
        return { kind: "allow", reason: "no decision model; judged offline" };
    }
    let score;
    try {
        const task = input.run.asked.trim();
        const result = await input.judge.evaluate({
            state: {
                task: task === "" ? "(no user request recorded in this session)" : redact(task),
                action: {
                    tool: input.call.name,
                    command: stripDataText(command).text,
                },
                context: [],
                floor_hits: [],
            },
            questions: { irreversible: questions.irreversible },
        });
        const answer = result.answers.irreversible;
        if (answer?.type === "noul")
            score = answer.noul;
    }
    catch {
        score = undefined;
    }
    if (score === undefined) {
        // A judge failure: live asks the person via the destructive flow;
        // a job fails closed.
        if (input.presence.kind === "job")
            return destructive;
        return {
            kind: "destructive",
            reasons: [
                `unrecognized shell command: ${command}`,
                "the irreversibility judgment failed",
            ],
        };
    }
    if (score >= input.settings.thresholds.irreversible)
        return destructive;
    if (score >= 0.5) {
        await input.log.append({
            conversationId: input.conversationId,
            tool: input.call.name,
            call: redact(JSON.stringify(input.call.arguments)),
            ...("owner" in input.presence && input.presence.owner !== undefined
                ? { owner: input.presence.owner }
                : {}),
            at: new Date().toISOString(),
            action: "allow-judged",
            scores: { irreversible: score },
        });
    }
    return { kind: "allow", reason: "the irreversibility judgment is below the hold band" };
}
/**
 * The live flow for a destructive call (spec §3.2 steps 1–5). The
 * caller guarantees a live presence; bash-unknown calls pass through
 * `judgeBashUnknown` first.
 */
export async function evaluateLive(input) {
    let classification = input.classification;
    if (classification.kind === "bash-unknown") {
        const resolved = await judgeBashUnknown(input);
        if (resolved.kind === "allow")
            return { action: "run" };
        classification = resolved;
    }
    if (classification.kind !== "destructive")
        return { action: "run" };
    const fp = callFingerprint(input.call);
    const reasons = classification.reasons;
    const tool = input.call.name;
    // Run boundary FIRST: the taint gate below consumes state.tainted, so
    // the reset must land before any read of it — otherwise the first
    // destructive call of a new run steers on the PREVIOUS run's taint.
    // (Matches the job path, which resets at the top of jobRoute.)
    const state = await input.store.update(input.conversationId, (s) => {
        resetRun(s, input);
        return s;
    });
    // Step 1–2: this call was held before (the fingerprint is in
    // state.blocked). Read the record first; the reply search and the
    // release's store.update follow.
    const record = state.blocked.find((entry) => entry.fingerprint === fp);
    if (record !== undefined) {
        const reply = findReply(input.run.entries, record.atEntry, state.released, fp);
        if (reply === undefined) {
            // Step 2: the ignored steer — the warden asks the person itself.
            return { action: "ask-person" };
        }
        // Step 1: approval on reply.
        const answer = await askApproval(input.judge ?? undefinedJudge, describeAction(tool, input.call.arguments, "/"), redact(reply.text).slice(-3000), redact(vagueSteerText(tool)).slice(-3000), reasons, { timeoutMs: APPROVAL_TIMEOUT_MS });
        if (!answer.ok)
            return { action: "ask-person" };
        if (answer.approved >= APPROVAL_THRESHOLD &&
            answer.pointsAtAction >= APPROVAL_THRESHOLD) {
            await input.store.update(input.conversationId, (s) => {
                s.blocked = s.blocked.filter((entry) => entry.fingerprint !== fp);
                s.released.push({ fingerprint: fp, replyEntry: reply.id });
            });
            await input.log.append({
                conversationId: input.conversationId,
                tool,
                call: redact(JSON.stringify(input.call.arguments)),
                ...("owner" in input.presence && input.presence.owner !== undefined
                    ? { owner: input.presence.owner }
                    : {}),
                at: new Date().toISOString(),
                action: "release",
                outcome: "approved",
            });
            return { action: "run" };
        }
        return await steer(input, fp, notApprovedSteerText(tool));
    }
    // Step 4: a judge failure or an undefined judge asks the person; a
    // tainted run (Task 15 sets the flag) skips the clear-ask judgment and
    // steers.
    if (state.tainted === true) {
        return await steer(input, fp, vagueSteerText(tool));
    }
    if (input.judge === undefined)
        return { action: "ask-person" };
    // Step 3: the clear-ask judgment.
    let clear;
    try {
        const result = await input.judge.evaluate({
            state: {
                request: redact(input.run.asked),
                call: redact(JSON.stringify(input.call.arguments)),
            },
            questions: { clear_ask: clearAskQuestion },
        });
        const answer = result.answers.clear_ask;
        if (answer?.type === "noul")
            clear = answer.noul;
    }
    catch {
        clear = undefined;
    }
    if (clear === undefined)
        return { action: "ask-person" };
    if (clear >= input.settings.thresholds.clearAsk) {
        await input.log.append({
            conversationId: input.conversationId,
            tool,
            call: redact(JSON.stringify(input.call.arguments)),
            ...("owner" in input.presence && input.presence.owner !== undefined
                ? { owner: input.presence.owner }
                : {}),
            at: new Date().toISOString(),
            action: "allow-judged",
            scores: { clear_ask: clear },
        });
        return { action: "run" };
    }
    return await steer(input, fp, vagueSteerText(tool));
}
/**
 * Record the hold (fingerprint + the entry the block sits after) and
 * count the steer against the run's steer budget. Over budget the warden
 * asks the person itself ("the rest to the log").
 */
async function steer(input, fp, text) {
    const maxEntry = input.run.entries.reduce((max, entry) => Math.max(max, Number(entry.id)), input.run.runStart === undefined ? -1 : Number(input.run.runStart));
    const budgeted = await input.store.update(input.conversationId, (s) => {
        resetRun(s, input);
        const record = s.blocked.find((entry) => entry.fingerprint === fp);
        if (record === undefined) {
            s.blocked.push({
                fingerprint: fp,
                at: new Date().toISOString(),
                atEntry: maxEntry >= 0 ? String(maxEntry) : undefined,
                status: "pending",
            });
        }
        if (s.steers >= input.settings.steerBudget)
            return false;
        s.steers += 1;
        return true;
    });
    await input.log.append({
        conversationId: input.conversationId,
        tool: input.call.name,
        call: redact(JSON.stringify(input.call.arguments)),
        ...("owner" in input.presence && input.presence.owner !== undefined
            ? { owner: input.presence.owner }
            : {}),
        at: new Date().toISOString(),
        action: "steer",
    });
    if (!budgeted)
        return { action: "ask-person" };
    return { action: "steer", text };
}
/** A new run resets the run-scoped fields (mirrors routeOffline). */
function resetRun(state, input) {
    if (state.runStart !== input.run.runStart) {
        state.runStart = input.run.runStart;
        state.steers = 0;
        state.tainted = undefined;
    }
}
/**
 * The approval path always has a real judge in practice (route.ts only
 * calls evaluateLive's destructive flow with one), but the typing keeps
 * askApproval total: an absent judge answers ok:false, which maps to
 * ask-person.
 */
const undefinedJudge = {
    evaluate: () => Promise.reject(new Error("not_configured: no decision judge")),
};
