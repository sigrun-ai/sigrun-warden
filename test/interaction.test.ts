/**
 * Task 11 interaction tests: the confirm body shape and the hold poll.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";

import { confirmBody, holdForPerson } from "../src/interaction.js";
import { grantKey } from "../src/state.js";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";

const CALL = {
	name: "acme-media/torrents_remove",
	arguments: { ids: [7, 9] },
};

function liveContext(): Context {
	return {
		cancellation: new Promise<never>(() => {}),
		onCancel: () => () => {},
		throwIfCancelled: () => {},
	} as unknown as Context;
}

describe("confirmBody", () => {
	it("is the allow/deny gate: markdown context + a Decision section", () => {
		const tree = confirmBody(CALL, ["MCP tool acme-media/torrents_remove is annotated destructive"]);
		const text = JSON.stringify(tree);
		expect(tree.root.type).toBe("form");
		expect((tree.root as { bind?: string }).bind).toBe("/values");
		expect((tree.root as { mode?: string }).mode).toBe("submit");
		expect(text).toContain('"markdown"');
		expect(text).toContain("acme-media/torrents_remove");
		expect(text).toContain("annotated destructive");
		expect(text).toContain('"choice"');
		expect(text).toContain('"decision"');
		expect(text).toContain('"allow"');
		expect(text).toContain('"deny"');
		expect(text).toContain('"longtext"');
		expect(text).toContain('"reason"');
	});

	it("redacts secret-looking argument values", () => {
		const tree = confirmBody(
			{
				name: "acme-media/torrents_add",
				arguments: {
					url: "https://example.invalid/x?token=sk-abc123def456ghi789jkl",
				},
			},
			["hold rule matched"],
		);
		expect(JSON.stringify(tree)).not.toContain("sk-abc123def456ghi789jkl");
	});
});

describe("holdForPerson", () => {
	let fake: FakeHost;
	afterEach(async () => {
		await fake.cleanup();
	});

	it("seeds one fingerprint-keyed pending record; allow resolves allow", async () => {
		fake = await createFakeHost({ answers: [{ decision: "allow" }] });
		const fp = grantKey(CALL.name, CALL.arguments).slice("warden:".length);
		const outcome = await holdForPerson(
			fake.host,
			CALL,
			1 as never,
			fp,
			["reason one"],
			liveContext(),
		);
		expect(outcome).toEqual({ answer: "allow", reason: "" });
		expect(fake.interactions.seeded).toHaveLength(1);
		expect(fake.interactions.seeded[0]!.callId).toBe(`warden-${fp}`);
		expect(fake.interactions.seeded[0]!.kind).toBe("warden.confirm");
	});

	it("deny carries the person's reason text", async () => {
		fake = await createFakeHost({
			answers: [{ decision: "deny", reason: "too risky right now" }],
		});
		const fp = grantKey(CALL.name, CALL.arguments).slice("warden:".length);
		const outcome = await holdForPerson(
			fake.host,
			CALL,
			1 as never,
			fp,
			["reason one"],
			liveContext(),
		);
		expect(outcome).toEqual({ answer: "deny", reason: "too risky right now" });
	});

	it("re-seeding with the same fingerprint is a no-op (one card)", async () => {
		fake = await createFakeHost({ answers: [{ decision: "allow" }] });
		const fp = grantKey(CALL.name, CALL.arguments).slice("warden:".length);
		// Two holds of the same fingerprint wait concurrently on the ONE record.
		const a = holdForPerson(fake.host, CALL, 1 as never, fp, ["r"], liveContext());
		const b = holdForPerson(fake.host, CALL, 1 as never, fp, ["r"], liveContext());
		const [oa, ob] = await Promise.all([a, b]);
		expect(oa.answer).toBe("allow");
		expect(ob.answer).toBe("allow");
		expect(fake.interactions.seeded).toHaveLength(1);
	});
});
