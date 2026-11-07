import type { WardenSettings } from "./settings.js";
export type Classification = {
    kind: "allow";
    reason: string;
    warns?: readonly string[];
} | {
    kind: "deny";
    reason: string;
} | {
    kind: "destructive";
    reasons: readonly string[];
    mcp?: {
        server: string;
        mcpName: string;
    };
    warns?: readonly string[];
} | {
    kind: "bash-unknown";
    command: string;
    warns?: readonly string[];
} | {
    /**
     * An MCP tool whose server declared no trustable annotation (or no
     * annotation provider is installed). Not presumed destructive: the
     * router judges irreversibility first, like bash-unknown.
     */
    kind: "mcp-unknown";
    reason: string;
    mcp: {
        server: string;
        mcpName: string;
    };
    warns?: readonly string[];
};
/**
 * The annotation answer for one MCP tool name (`server/mcpName`):
 * `found` carries the published annotation entry, `unknown` means the
 * provider answered but the tool carried no trustable annotation
 * (`unknown: true`), and `no-provider` means no extension publishes the
 * `mcp.tool-annotations` hook at all.
 */
export type AnnotationLookup = {
    status: "found";
    server: string;
    mcpName: string;
    readOnly?: boolean;
    destructive?: boolean;
} | {
    status: "unknown";
} | {
    status: "no-provider";
};
export interface ClassifyDeps {
    annotations(tool: string): Promise<AnnotationLookup>;
    settings: WardenSettings;
}
/**
 * The published-hook call Task 11's host wiring uses, kept here so both
 * the factory and future tests share the mapping: the hook is
 * `mcp.tool-annotations`; `absent` maps to `no-provider`, an `ok` value
 * with `unknown: true` maps to `unknown`, anything else `ok` is the
 * annotation entry.
 */
export declare function annotationFromHookResult(tool: string, result: {
    status: "absent";
} | {
    status: "ok";
    value: unknown;
} | {
    status: string;
}): AnnotationLookup;
/**
 * Classify one tool call. The order is the warden spec's:
 * 1. deny rule → deny;
 * 2. core read-only names → allow;
 * 3. bash: read-only → allow; `matchPatterns` on the RAW command →
 *    destructive; else bash-unknown;
 * 4. a name containing `/` → the annotations lookup (readOnly or
 *    `destructive === false` → allow; annotated destructive →
 *    destructive with the mcp pair; unknown / no-provider → a matching
 *    hold rule makes it destructive, else mcp-unknown, which the router
 *    judges for irreversibility before any hold);
 * 5. hold rules → destructive;
 * 6. otherwise allow.
 * `warn` rules never change the verdict; the matched patterns come back
 * in `warns` so the caller writes the warn log records.
 */
export declare function classify(call: {
    name: string;
    arguments: Record<string, unknown>;
}, deps: ClassifyDeps): Promise<Classification>;
