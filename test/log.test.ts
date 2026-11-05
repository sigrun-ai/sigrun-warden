import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HoldLog, type HoldRecord } from "../src/log.js";

describe("HoldLog", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sigrun-warden-log-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const record = (overrides: Partial<HoldRecord> = {}): HoldRecord => ({
		at: new Date("2026-11-05T12:00:00.000Z").toISOString(),
		conversationId: 7,
		owner: "alice",
		tool: "bash",
		call: JSON.stringify({ command: "ls -la" }),
		action: "hold",
		...overrides,
	});

	it("append + recent round-trip", async () => {
		const log = new HoldLog(join(root, "holds.jsonl"), () => new Date());
		await log.append(record({ tool: "acme-media/torrents_add" }));
		await log.append(record({ tool: "acme-media/torrents_remove" }));
		const all = await log.recent(10);
		expect(all).toHaveLength(2);
		expect(all[0].tool).toBe("acme-media/torrents_add");
		expect(all[1].tool).toBe("acme-media/torrents_remove");
		const one = await log.recent(1);
		expect(one).toHaveLength(1);
		expect(one[0].tool).toBe("acme-media/torrents_remove");
	});

	it("recent on a missing file returns []", async () => {
		const log = new HoldLog(join(root, "absent", "holds.jsonl"), () => new Date());
		expect(await log.recent(5)).toEqual([]);
	});

	it("prune keeps a 200-day hold and drops a 200-day allow-judged", async () => {
		const now = new Date("2026-11-05T12:00:00.000Z");
		const days = 24 * 60 * 60 * 1000;
		const log = new HoldLog(join(root, "holds.jsonl"), () => now);
		const oldAt = new Date(now.getTime() - 200 * days).toISOString();
		await log.append(record({ action: "hold", at: oldAt, tool: "bash" }));
		await log.append(record({ action: "block", at: oldAt, tool: "write" }));
		await log.append(record({ action: "escalate", at: oldAt, tool: "edit" }));
		await log.append(record({ action: "allow-judged", at: oldAt, tool: "bash" }));
		await log.append(record({ action: "warn", at: oldAt, tool: "read" }));
		await log.append(record({ action: "allow-judged", tool: "acme-media/torrents_list" }));

		await log.prune({ calls: 90, holds: 365 });

		const kept = await log.recent(10);
		expect(kept.map((r) => r.action)).toEqual([
			"hold",
			"block",
			"escalate",
			"allow-judged", // fresh record, within the calls window
		]);
		// The surviving allow-judged is the fresh one.
		expect(kept[3].at).toBe(now.toISOString());
	});
});
