import { createHash } from "node:crypto";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { afterToolGuard } from "./after.js";
import { annotationFromHookResult, classify } from "./classify.js";
import { buildCard } from "./cards.js";
import { createWardenCommands } from "./commands.js";
import { presenceOf, runInfo } from "./context.js";
import { Cooldown, decisionsJudge } from "./judge.js";
import { HoldLog } from "./log.js";
import { resolveReservedGrant, routeOffline, startPruneOnce, } from "./route.js";
import { WARDEN_SETTINGS_SCHEMA } from "./settings-schema.js";
import { StateStore } from "./state.js";
import { toolExecuted } from "./tool-executed.js";
/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 11 wires the ToolTask hook's beforeTool/afterTool for the
 * NO-decision-model path: live conversations hold a call on an
 * interaction question; job runs block + escalate (one-shot grants).
 * The judge (Task 12) drives live calls; the clearance + card-check
 * path (Task 14) drives cleared job calls.
 */
export default function createWarden(host, deps = {}) {
    void deps;
    // Declare first: the settings page, the defaults and the malformed-value
    // repair are core's from here on. Every read is per tool call — never in
    // this factory body, whose provisional slug is the package's
    // (`warden`), not the declared name's (`sigrun-warden`).
    const settingsHandle = host.settings.declare({
        schema: WARDEN_SETTINGS_SCHEMA,
    });
    const log = new HoldLog(`${host.stores.paths.state}/holds.jsonl`, () => new Date());
    const store = new StateStore(host.stores.paths.state);
    // Instance-wide judge cooldown (in memory — a restart re-trusts the judge).
    const cooldown = new Cooldown();
    const beforeTool = async (call, api, context) => {
        // The hook's contract: catch EVERYTHING and block — never let a
        // call through on an exception.
        try {
            const settings = await settingsHandle.get();
            startPruneOnce(log, settings.retentionDays);
            const annotations = async (tool) => annotationFromHookResult(tool, (await host.publishedHooks.call("mcp.tool-annotations", { tool }, { conversationId: api.conversationId })));
            const classification = await classify({ name: call.name, arguments: call.arguments }, { annotations, settings });
            const presence = await presenceOf(host, api.conversationId);
            const run = await runInfo(host, api.conversationId);
            const judge = decisionsJudge(host, settings, cooldown, "owner" in presence ? presence.owner : undefined);
            return await routeOffline({
                host,
                call,
                conversationId: api.conversationId,
                classification,
                presence,
                run,
                settings,
                store,
                log,
                context,
                judge,
                cooldown,
            });
        }
        catch (error) {
            return { block: `warden error: ${errorMessage(error)}` };
        }
    };
    const afterTool = async (call, result, api, _context) => {
        // pi-durable 1.5.0 (spec §3.2-b): the harness runs afterTool on
        // results IT wrote for calls that never executed (blocked,
        // invalid_arguments, tool_unavailable, ...) — where
        // `call.arguments` may be raw unvalidated model text. Nothing
        // below may observe such a result: no grant resolution, no stuck
        // count, no card collection. `undefined` passes it through.
        if (!toolExecuted(result))
            return undefined;
        // Task 13: a skill arriving in the run (a `load_skill` result or a
        // `read` of a SKILL.md path) starts a BACKGROUND card build —
        // single-flight per body hash; failures warn and never block.
        const skill = skillFromToolResult(call, result);
        if (skill !== undefined) {
            void (async () => {
                try {
                    const settings = await settingsHandle.get();
                    const card = await buildCard(host, skill, settings);
                    if (card === undefined) {
                        console.warn(`warden: card build failed for ${skill.name}`);
                    }
                }
                catch (error) {
                    console.warn("warden: card build failed", error);
                }
            })();
        }
        // Task 11 slice: resolve grants.
        try {
            await resolveReservedGrant({
                host,
                call,
                conversationId: api.conversationId,
                result,
                store,
            });
        }
        catch (error) {
            console.warn("warden: afterTool grant resolution failed", error);
        }
        // Task 15, LAST in the pipeline (skill collection and grant
        // resolution above): masking → planted-instructions taint → stuck.
        // A thrown guard must never drop the tool's result.
        try {
            const settings = await settingsHandle.get();
            let user;
            try {
                const presence = await presenceOf(host, api.conversationId);
                user = "owner" in presence ? presence.owner : undefined;
            }
            catch {
                // A presence failure only loses the judge's per-user default;
                // masking, taint, and stuck checks must still run.
            }
            const run = await runInfo(host, api.conversationId);
            return await afterToolGuard(call, result, {
                host,
                conversationId: api.conversationId,
                run,
                settings,
                store,
                log,
                judge: decisionsJudge(host, settings, cooldown, user),
                context: _context,
            });
        }
        catch (error) {
            console.warn("warden: afterTool guard failed", error);
            return undefined;
        }
    };
    return {
        title: "Warden",
        extension: defineExtension({
            name: "sigrun.warden",
            tools: [],
            hooks: [hook(ToolTask, { beforeTool, afterTool })],
        }),
        interactionKinds: ["warden.confirm"],
        commands: createWardenCommands(host, settingsHandle),
    };
}
/**
 * The skill a tool result introduces into the run, when it does: a
 * `load_skill` result (name from the call's args) or a `read` of a path
 * ending SKILL.md (name = the parent directory's leaf). The body is the
 * result's text.
 */
function skillFromToolResult(call, result) {
    const text = toolResultText(result);
    if (text === "" || result.isError === true)
        return undefined;
    const args = call.arguments;
    if (call.name === "load_skill") {
        const name = typeof args.skill === "string"
            ? args.skill
            : typeof args.name === "string"
                ? args.name
                : undefined;
        if (name === undefined)
            return undefined;
        return { name, body: text, hash: bodyHash(text) };
    }
    if (call.name === "read" && typeof args.path === "string" && args.path.endsWith("SKILL.md")) {
        const segments = args.path.split("/").filter((part) => part.length > 0);
        const name = segments.length >= 2 ? segments[segments.length - 2] : segments[0];
        return { name, location: args.path, body: text, hash: bodyHash(text) };
    }
    return undefined;
}
/** The concatenated text blocks of a tool result's output. */
function toolResultText(result) {
    const output = result.output;
    if (typeof output === "string")
        return output;
    if (!Array.isArray(output))
        return "";
    const parts = [];
    for (const block of output) {
        if (typeof block === "object" &&
            block !== null &&
            block.type === "text" &&
            typeof block.text === "string") {
            parts.push(block.text);
        }
    }
    return parts.join("\n");
}
function bodyHash(body) {
    return createHash("sha256").update(body, "utf8").digest("hex");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export { WARDEN_SETTINGS_SCHEMA, defaultSettings } from "./settings-schema.js";
export { classify, annotationFromHookResult } from "./classify.js";
export { HoldLog } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
export { presenceOf, runInfo } from "./context.js";
export { grantKey, StateStore } from "./state.js";
export { confirmBody, holdForPerson, WARDEN_CONFIRM_KIND } from "./interaction.js";
export { escalationBody, raiseEscalation, resolveGrant, takeGrant, } from "./escalate.js";
export { resetPruneGuardForTests, resolveReservedGrant, routeOffline, startPruneOnce, } from "./route.js";
export { afterToolGuard, resetAttemptWindowsForTests } from "./after.js";
export { Cooldown, decisionsJudge } from "./judge.js";
export { clearAskQuestion } from "./questions.js";
export { evaluateLive, judgeBashUnknown } from "./live.js";
export { skillTagsInText, skillsInRun } from "./skills.js";
export { buildCard, CARD_MAX_BYTES, CARD_SYSTEM_PROMPT, CARD_TIMEOUT_MS, CardStore, resetInflightForTests, } from "./cards.js";
export { createWardenCommands } from "./commands.js";
export { targetsOf } from "./targets.js";
export { EVIDENCE_BUDGET_BYTES, evidenceFor } from "./evidence.js";
export { cardCheck } from "./card-check.js";
