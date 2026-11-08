/**
 * Task 13 skills tests: the three channels a skill reaches a run
 * (an expanded `<skill>` block, a `load_skill` result paired with its
 * call, a `read` of a path ending SKILL.md), dedup by body hash, newest first.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";

import {
	skillTagsInText,
	skillsInRun,
	type SkillSeen,
} from "../src/skills.js";
import { resetEntryIds, toolCallEntry, toolResultEntry, userEntry } from "./fake-host.js";
import type { EntryRecord } from "@earendil-works/pi-durable";

const BODY = "Cleanup finished torrents.\n1. Run torrents_list first.\n2. Then torrents_remove may run.";
const HASH = createHash("sha256").update(BODY, "utf8").digest("hex");

function sha(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeEach(() => {
	resetEntryIds();
});

describe("skillTagsInText", () => {
	it("extracts name and location attributes", () => {
		const tags = skillTagsInText(
			'go do it\n<skill name="acme-cleanup" location="/home/alice/skills/acme-cleanup/SKILL.md">\nbody\n</skill>',
		);
		expect(tags).toEqual([
			{ name: "acme-cleanup", location: "/home/alice/skills/acme-cleanup/SKILL.md" },
		]);
	});

	it("location is optional", () => {
		expect(skillTagsInText('<skill name="acme-cleanup">x</skill>')).toEqual([
			{ name: "acme-cleanup" },
		]);
	});
});

describe("skillsInRun", () => {
	it('a core-shape <skill> block (with the References preamble) is collected as the bare body', () => {
		// Core's real expansion (dist/commands/expand.js):
		// <skill name="…" location="…">\nReferences are relative to <dir>.\n\n<body>\n</skill>
		const prompt = `Please run the cleanup.\n<skill name="acme-cleanup" location="/home/alice/skills/acme-cleanup/SKILL.md">\nReferences are relative to /home/alice/skills/acme-cleanup.\n\n${BODY}\n</skill>`;
		const seen = skillsInRun([userEntry(prompt) as unknown as EntryRecord]);
		expect(seen).toHaveLength(1);
		// The preamble is NOT part of the body: the hash matches the bare
		// SKILL.md text and no absolute path reaches the card prompt.
		expect(seen[0]).toEqual<SkillSeen>({
			name: "acme-cleanup",
			location: "/home/alice/skills/acme-cleanup/SKILL.md",
			body: BODY,
			hash: HASH,
		});
	});

	it("preamble with a space in the path", () => {
		const body = "Archive the stale records.";
		const prompt = `<skill name="acme-archive" location="/data/my skills/acme.v2/SKILL.md">\nReferences are relative to /data/my skills/acme.v2.\n\n${body}\n</skill>`;
		const seen = skillsInRun([userEntry(prompt) as unknown as EntryRecord]);
		expect(seen).toEqual<SkillSeen[]>([
			{
				name: "acme-archive",
				location: "/data/my skills/acme.v2/SKILL.md",
				body,
				hash: sha(body),
			},
		]);

		const withoutPreamble = `<skill name="acme-archive">${body}</skill>`;
		expect(
			skillsInRun([userEntry(withoutPreamble) as unknown as EntryRecord])[0]?.body,
		).toBe(body);
	});

	it("two same-named <skill> blocks each hash their own body", () => {
		const edited = `${BODY}\n3. Never touch seeding torrents.`;
		const prompt = `<skill name="acme-cleanup">\n${BODY}\n</skill>\nlater\n<skill name="acme-cleanup">\n${edited}\n</skill>`;
		const seen = skillsInRun([userEntry(prompt) as unknown as EntryRecord]);
		expect(seen).toHaveLength(2);
		const hashes = seen.map((skill) => skill.hash).sort();
		expect(hashes).toEqual([HASH, sha(edited)].sort());
	});

	it("a load_skill result is collected with its name", () => {
		const call = toolCallEntry("load_skill", { skill: "acme-cleanup" });
		const result = toolResultEntry("load_skill", BODY);
		const seen = skillsInRun([call, result] as unknown as EntryRecord[]);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.name).toBe("acme-cleanup");
		expect(seen[0]!.body).toBe(BODY);
		expect(seen[0]!.hash).toBe(HASH);
	});

	it("a read of skills/acme-cleanup/SKILL.md is collected", () => {
		const call = toolCallEntry("read", { path: "skills/acme-cleanup/SKILL.md" });
		const result = toolResultEntry("read", BODY, "read-1");
		const seen = skillsInRun([call, result] as unknown as EntryRecord[]);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.name).toBe("acme-cleanup");
		expect(seen[0]!.location).toBe("skills/acme-cleanup/SKILL.md");
		expect(seen[0]!.body).toBe(BODY);
	});

	it("a read of a non-SKILL.md path is not collected", () => {
		const call = toolCallEntry("read", { path: "src/skills.ts" });
		const result = toolResultEntry("read", BODY, "read-1");
		expect(skillsInRun([call, result] as unknown as EntryRecord[])).toEqual([]);
	});

	it("the same body twice is one entry", () => {
		const prompt = `<skill name="acme-cleanup">\n${BODY}\n</skill>`;
		const call = toolCallEntry("load_skill", { skill: "acme-cleanup" });
		const result = toolResultEntry("load_skill", BODY);
		const seen = skillsInRun([
			userEntry(prompt),
			call,
			result,
		] as unknown as EntryRecord[]);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.hash).toBe(HASH);
	});

	it("dedup is by hash, newest first", () => {
		const edited = `${BODY}\n3. Never touch seeding torrents.`;
		// Oldest first input; the edited body is the newest.
		const first = toolCallEntry("load_skill", { skill: "acme-cleanup" }, "load_skill-1");
		const firstResult = toolResultEntry("load_skill", BODY, "load_skill-1");
		const second = toolCallEntry("load_skill", { skill: "acme-cleanup" }, "load_skill-2");
		const secondResult = toolResultEntry("load_skill", edited, "load_skill-2");
		const seen = skillsInRun([
			first,
			firstResult,
			second,
			secondResult,
		] as unknown as EntryRecord[]);
		expect(seen).toHaveLength(2);
		expect(seen[0]!.hash).toBe(sha(edited));
		expect(seen[1]!.hash).toBe(HASH);
	});
});
