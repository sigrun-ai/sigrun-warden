/**
 * Action classification (warden spec §3.1). Pure over injected deps: the
 * MCP annotations lookup is provided by the caller (Task 11 wires it to
 * `host.publishedHooks.call("mcp.tool-annotations", …)`; tests inject
 * fakes).
 */
import { isReadOnlyCommand, matchPatterns } from "pi-warden";
import { matchGlob } from "./glob.js";
/** Core tool names that are always read-only. */
const CORE_READ_ONLY = new Set(["read", "ls", "find", "grep", "load_skill"]);
function splitMcpName(name) {
    const slash = name.indexOf("/");
    return { server: name.slice(0, slash), mcpName: name.slice(slash + 1) };
}
/**
 * The published-hook call Task 11's host wiring uses, kept here so both
 * the factory and future tests share the mapping: the hook is
 * `mcp.tool-annotations`; `absent` maps to `no-provider`, an `ok` value
 * with `unknown: true` maps to `unknown`, anything else `ok` is the
 * annotation entry.
 */
export function annotationFromHookResult(tool, result) {
    if (result.status === "absent")
        return { status: "no-provider" };
    if (result.status !== "ok")
        return { status: "no-provider" };
    const value = result.value;
    if (typeof value !== "object" || value === null)
        return { status: "unknown" };
    const record = value;
    if (record.unknown === true)
        return { status: "unknown" };
    const { server, mcpName } = splitMcpName(tool);
    return {
        status: "found",
        server,
        mcpName,
        ...(typeof record.readOnly === "boolean" ? { readOnly: record.readOnly } : {}),
        ...(typeof record.destructive === "boolean"
            ? { destructive: record.destructive }
            : {}),
    };
}
/** Every string argument of a tool call (the `path`-rule match surface). */
function stringArguments(args) {
    const out = [];
    for (const value of Object.values(args)) {
        if (typeof value === "string")
            out.push(value);
    }
    return out;
}
/**
 * Classify one tool call. The order is the warden spec's:
 * 1. deny rule → deny;
 * 2. core read-only names → allow;
 * 3. bash: read-only → allow; `matchPatterns` on the RAW command →
 *    destructive; else bash-unknown;
 * 4. a name containing `/` → the annotations lookup (readOnly or
 *    `destructive === false` → allow; destructive / unknown /
 *    no-provider → destructive with the mcp pair);
 * 5. hold rules → destructive;
 * 6. otherwise allow.
 * `warn` rules never change the verdict; the matched patterns come back
 * in `warns` so the caller writes the warn log records.
 */
export async function classify(call, deps) {
    const { name, arguments: args } = call;
    const rules = deps.settings.rules;
    const command = typeof args.command === "string" ? args.command : undefined;
    const ruleTargets = (match) => {
        if (match === "tool")
            return [name];
        if (match === "command")
            return command === undefined ? [] : [command];
        return stringArguments(args);
    };
    for (const rule of rules) {
        if (rule.level !== "deny")
            continue;
        const target = ruleTargets(rule.match).find((value) => matchGlob(value, [rule.pattern]) !== undefined);
        if (target !== undefined) {
            return {
                kind: "deny",
                reason: `deny rule ${JSON.stringify(rule.pattern)} matched ${JSON.stringify(target)}`,
            };
        }
    }
    const warns = [];
    for (const rule of rules) {
        if (rule.level !== "warn")
            continue;
        const target = ruleTargets(rule.match).find((value) => matchGlob(value, [rule.pattern]) !== undefined);
        if (target !== undefined)
            warns.push(rule.pattern);
    }
    const withWarns = (classification) => warns.length === 0 ? classification : { ...classification, warns };
    // 2. Core read-only names.
    if (CORE_READ_ONLY.has(name)) {
        return withWarns({ kind: "allow", reason: `core tool ${name} is read-only` });
    }
    // 3. Bash.
    if (name === "bash") {
        if (command !== undefined && isReadOnlyCommand(command)) {
            return withWarns({ kind: "allow", reason: "read-only shell command" });
        }
        // matchPatterns does its own comment/heredoc handling — never pre-strip.
        if (command !== undefined) {
            const hits = matchPatterns("bash", { command });
            if (hits.length > 0) {
                return withWarns({
                    kind: "destructive",
                    reasons: hits.map((hit) => hit.label),
                });
            }
        }
        return withWarns({ kind: "bash-unknown", command: command ?? "" });
    }
    // 4. MCP tools (`server/mcpName`) via the annotations lookup.
    if (name.includes("/")) {
        const annotation = await deps.annotations(name);
        if (annotation.status === "found") {
            if (annotation.readOnly === true) {
                return withWarns({
                    kind: "allow",
                    reason: `MCP tool ${name} is annotated readOnly`,
                });
            }
            if (annotation.destructive === false) {
                return withWarns({
                    kind: "allow",
                    reason: `MCP tool ${name} is annotated non-destructive`,
                });
            }
            return withWarns({
                kind: "destructive",
                reasons: [`MCP tool ${name} is annotated destructive`],
                mcp: { server: annotation.server, mcpName: annotation.mcpName },
            });
        }
        if (annotation.status === "unknown") {
            return withWarns({
                kind: "destructive",
                reasons: [`MCP tool ${name} has no trustable annotation`],
                mcp: splitMcpName(name),
            });
        }
        return withWarns({
            kind: "destructive",
            reasons: [
                `no MCP annotation provider is available; treating ${name} as destructive`,
            ],
            mcp: splitMcpName(name),
        });
    }
    // 5. Hold rules.
    for (const rule of rules) {
        if (rule.level !== "hold")
            continue;
        const target = ruleTargets(rule.match).find((value) => matchGlob(value, [rule.pattern]) !== undefined);
        if (target !== undefined) {
            return withWarns({
                kind: "destructive",
                reasons: [
                    `hold rule ${JSON.stringify(rule.pattern)} matched ${JSON.stringify(target)}`,
                ],
            });
        }
    }
    // 6. Otherwise allow.
    return withWarns({ kind: "allow", reason: `no rule or annotation covers ${name}` });
}
