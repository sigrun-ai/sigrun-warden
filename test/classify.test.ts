import { describe, expect, it, vi } from "vitest";

import {
	annotationFromHookResult,
	classify,
	type AnnotationLookup,
} from "../src/classify.js";
import { defaultSettings, type WardenSettings } from "../src/settings.js";

const settings = (overrides: Partial<WardenSettings> = {}): WardenSettings => ({
	...defaultSettings(),
	...overrides,
});

const annotationDeps = (
	lookup: AnnotationLookup | ((tool: string) => AnnotationLookup),
) => ({
	annotations: async (tool: string) =>
		typeof lookup === "function" ? lookup(tool) : lookup,
	settings: settings(),
});

describe("classify: core tools and bash", () => {
	it("read is allow", async () => {
		const result = await classify(
			{ name: "read", arguments: { path: "/etc/hostname" } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(result).toMatchObject({ kind: "allow" });
	});

	it("bash \"ls -la\" is allow", async () => {
		const result = await classify(
			{ name: "bash", arguments: { command: "ls -la" } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(result).toMatchObject({ kind: "allow" });
	});

	it("bash \"rm -rf /data\" is destructive", async () => {
		const result = await classify(
			{ name: "bash", arguments: { command: "rm -rf /data" } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(result.kind).toBe("destructive");
	});

	it("bash \"make deploy\" is bash-unknown", async () => {
		const result = await classify(
			{ name: "bash", arguments: { command: "make deploy" } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(result).toMatchObject({ kind: "bash-unknown", command: "make deploy" });
	});

	it("bash destructive matching does its own comment stripping (never pre-strip)", async () => {
		// classify passes the raw command to matchPatterns; a destructive
		// command hidden in a comment must NOT match (matchPatterns strips
		// comments itself), while the same words in command position must.
		const commented = "ls # " + ["rm", "-rf", "/data"].join(" ");
		const real = ["rm", "-rf", "/data"].join(" ");
		const asComment = await classify(
			{ name: "bash", arguments: { command: commented } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(asComment.kind).toBe("allow");
		const direct = await classify(
			{ name: "bash", arguments: { command: real } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(direct.kind).toBe("destructive");
	});
});

it("bash heredoc body is data to matchPatterns (never destructive)", async () => {
// classify passes the raw command to matchPatterns, which treats
// heredoc bodies as data: a destructive line inside the body must NOT
// match. pi-warden's isReadOnlyCommand refuses scripts with operators,
// so with the operator guard the verdict is bash-unknown — safe (held),
// never destructive.
const heredoc = "cat <<EOF\nrm -rf /data\nEOF";
const asHeredoc = await classify(
{ name: "bash", arguments: { command: heredoc } },
annotationDeps({ status: "no-provider" }),
);
expect(asHeredoc.kind).toBe("bash-unknown");
// An inert heredoc body lands the same way.
const benign = await classify(
{ name: "bash", arguments: { command: "cat <<EOF\nhello\nEOF" } },
annotationDeps({ status: "no-provider" }),
);
expect(benign.kind).toBe("bash-unknown");
// …while the same words as a real command are destructive (control).
const direct = await classify(
{ name: "bash", arguments: { command: "rm -rf /data" } },
annotationDeps({ status: "no-provider" }),
);
expect(direct.kind).toBe("destructive");
});

describe("classify: MCP tools", () => {
	it("acme-media/torrents_list readOnly → allow", async () => {
		const result = await classify(
			{ name: "acme-media/torrents_list", arguments: {} },
			annotationDeps({
				status: "found",
				server: "acme-media",
				mcpName: "torrents_list",
				readOnly: true,
			}),
		);
		expect(result).toMatchObject({ kind: "allow" });
	});

	it("acme-media/torrents_add destructive false → allow", async () => {
		const result = await classify(
			{
				name: "acme-media/torrents_add",
				arguments: { url: "https://example.invalid/x.torrent" },
			},
			annotationDeps({
				status: "found",
				server: "acme-media",
				mcpName: "torrents_add",
				destructive: false,
			}),
		);
		expect(result).toMatchObject({ kind: "allow" });
	});

	it("acme-media/torrents_remove destructive → destructive with mcpName", async () => {
		const result = await classify(
			{ name: "acme-media/torrents_remove", arguments: { id: "1" } },
			annotationDeps({
				status: "found",
				server: "acme-media",
				mcpName: "torrents_remove",
				destructive: true,
			}),
		);
		expect(result.kind).toBe("destructive");
		if (result.kind === "destructive") {
			expect(result.mcp).toEqual({
				server: "acme-media",
				mcpName: "torrents_remove",
			});
		}
	});

	it("unknown annotation → destructive", async () => {
		const result = await classify(
			{ name: "acme-media/torrents_remove", arguments: { id: "1" } },
			annotationDeps({ status: "unknown" }),
		);
		expect(result.kind).toBe("destructive");
		if (result.kind === "destructive") {
			expect(result.mcp).toEqual({
				server: "acme-media",
				mcpName: "torrents_remove",
			});
		}
	});

	it("no provider → acme-media/torrents_remove destructive (escalate class)", async () => {
		const result = await classify(
			{ name: "acme-media/torrents_remove", arguments: { id: "1" } },
			annotationDeps({ status: "no-provider" }),
		);
		expect(result.kind).toBe("destructive");
		if (result.kind === "destructive") {
			expect(result.mcp).toEqual({
				server: "acme-media",
				mcpName: "torrents_remove",
			});
		}
	});

	it("a name without \"/\" with no provider is allow (no lookup attempted)", async () => {
		const annotations = vi.fn(async (): Promise<AnnotationLookup> => {
			throw new Error("must not be called");
		});
		const result = await classify(
			{ name: "write", arguments: { path: "notes.md", content: "hi" } },
			{ annotations, settings: settings() },
		);
		expect(result).toMatchObject({ kind: "allow" });
		expect(annotations).not.toHaveBeenCalled();
	});
});

describe("classify: rules", () => {
	it("deny beats everything", async () => {
		const deps = {
			annotations: async (): Promise<AnnotationLookup> => ({
				status: "found",
				server: "acme-media",
				mcpName: "torrents_list",
				readOnly: true,
			}),
			settings: settings({
				rules: [{ match: "tool", pattern: "acme-media/*", level: "deny" }],
			}),
		};
		// Even a readOnly-annotated MCP tool denies, and a core read-only denies.
		expect(
			(await classify({ name: "acme-media/torrents_list", arguments: {} }, deps)).kind,
		).toBe("deny");
		const denyCore = await classify(
			{ name: "read", arguments: { path: "x" } },
			{
				...deps,
				settings: settings({
					rules: [{ match: "tool", pattern: "read", level: "deny" }],
				}),
			},
		);
		expect(denyCore.kind).toBe("deny");
	});

	it("a hold rule on a path makes write destructive", async () => {
		const result = await classify(
			{ name: "write", arguments: { path: "secrets/prod.env", content: "x" } },
			{
				annotations: async (): Promise<AnnotationLookup> => ({ status: "no-provider" }),
				settings: settings({
					rules: [{ match: "path", pattern: "secrets/*", level: "hold" }],
				}),
			},
		);
		expect(result.kind).toBe("destructive");
	});

	it("a warn rule allows and surfaces the pattern for logging", async () => {
		const result = await classify(
			{ name: "read", arguments: { path: "/tmp/scratch.txt" } },
			{
				annotations: async (): Promise<AnnotationLookup> => ({ status: "no-provider" }),
				settings: settings({
					rules: [{ match: "path", pattern: "/tmp/*", level: "warn" }],
				}),
			},
		);
		expect(result).toMatchObject({ kind: "allow", warns: ["/tmp/*"] });
	});
});

describe("annotationFromHookResult", () => {
	it("maps absent → no-provider", () => {
		expect(annotationFromHookResult("acme-media/torrents_list", { status: "absent" })).toEqual({
			status: "no-provider",
		});
	});

	it("maps ok with unknown:true → unknown", () => {
		expect(
			annotationFromHookResult("acme-media/torrents_list", {
				status: "ok",
				value: { unknown: true },
			}),
		).toEqual({ status: "unknown" });
	});

	it("maps ok value to the annotation entry, split from the tool name", () => {
		expect(
			annotationFromHookResult("acme-media/torrents_list", {
				status: "ok",
				value: { readOnly: true },
			}),
		).toEqual({
			status: "found",
			server: "acme-media",
			mcpName: "torrents_list",
			readOnly: true,
		});
	});
});

describe("pi-warden smoke test", () => {
	it("the root export loads with no @earendil-works/pi-coding-agent or pi-tui installed", async () => {
		const mod = await import("pi-warden");
		expect(typeof mod.matchPatterns).toBe("function");
		expect(typeof mod.isReadOnlyCommand).toBe("function");
		expect(typeof mod.describeAction).toBe("function");
		// pi-tui / @earendil-works/pi-coding-agent are NOT in this package's
		// dependency graph (package.json), so the root export's loadability
		// without them is proven by this import itself.
	});
});
