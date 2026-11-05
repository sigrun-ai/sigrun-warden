import { createHash } from "node:crypto";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { annotationFromHookResult, classify } from "./classify.js";
import { buildCard } from "./cards.js";
import { createWardenCommands } from "./commands.js";
import { presenceOf, runInfo } from "./context.js";
import { Cooldown, decisionsJudge } from "./judge.js";
import { HoldLog } from "./log.js";
import { resolveReservedGrant, routeOffline, startPruneOnce, } from "./route.js";
import { parseSettings } from "./settings.js";
import { StateStore } from "./state.js";
/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 11 wires the ToolTask hook's beforeTool/afterTool for the
 * NO-decision-model path: live conversations hold a call on an
 * interaction question; job runs block + escalate (one-shot grants).
 * The judge (Task 12) and clearances (Task 14) slot in later.
 */
export default function createWarden(host, deps = {}) {
    void deps;
    const log = new HoldLog(`${host.stores.paths.state}/holds.jsonl`, () => new Date());
    const store = new StateStore(host.stores.paths.state);
    // Instance-wide judge cooldown (in memory — a restart re-trusts the judge).
    const cooldown = new Cooldown();
    const beforeTool = async (call, api, context) => {
        // The hook's contract: catch EVERYTHING and block — never let a
        // call through on an exception.
        try {
            const raw = await host.stores.settings.get();
            const settings = parseSettings(raw, (message) => console.warn(message));
            startPruneOnce(log, settings.retentionDays);
            const annotations = async (tool) => annotationFromHookResult(tool, (await host.publishedHooks.call("mcp.tool-annotations", { tool }, { conversationId: api.conversationId })));
            const classification = await classify({ name: call.name, arguments: call.arguments }, { annotations, settings });
            const presence = await presenceOf(host, api.conversationId);
            const run = await runInfo(host, api.conversationId);
            const judge = decisionsJudge(host, settings, cooldown);
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
        // Task 13: a skill arriving in the run (a `load_skill` result or a
        // `read` of a SKILL.md path) starts a BACKGROUND card build —
        // single-flight per body hash; failures warn and never block.
        const skill = skillFromToolResult(call, result);
        if (skill !== undefined) {
            void (async () => {
                try {
                    const raw = await host.stores.settings.get();
                    const settings = parseSettings(raw, (message) => console.warn(message));
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
        // Task 11 slice: resolve grants. Planted-instructions / masking /
        // stuck guards are Task 15 and are omitted here entirely.
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
        return undefined;
    };
    return {
        extension: defineExtension({
            name: "sigrun.warden",
            tools: [],
            hooks: [hook(ToolTask, { beforeTool, afterTool })],
        }),
        interactionKinds: ["warden.confirm"],
        commands: createWardenCommands(host),
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
export { parseSettings, defaultSettings, resetWarnedKeys } from "./settings.js";
export { classify, annotationFromHookResult } from "./classify.js";
export { HoldLog } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
export { presenceOf, runInfo } from "./context.js";
export { grantKey, StateStore } from "./state.js";
export { confirmBody, holdForPerson, WARDEN_CONFIRM_KIND } from "./interaction.js";
export { escalationBody, raiseEscalation, resolveGrant, takeGrant, } from "./escalate.js";
export { resetPruneGuardForTests, resolveReservedGrant, routeOffline, startPruneOnce, } from "./route.js";
export { Cooldown, decisionsJudge } from "./judge.js";
export { clearAskQuestion } from "./questions.js";
export { evaluateLive, judgeBashUnknown } from "./live.js";
export { skillTagsInText, skillsInRun } from "./skills.js";
export { buildCard, CARD_MAX_BYTES, CARD_SYSTEM_PROMPT, CARD_TIMEOUT_MS, CardStore, resetInflightForTests, } from "./cards.js";
export { createWardenCommands } from "./commands.js";
