/**
 * Task 14 targets + card check: `targetsOf` argument extraction and the
 * per-target card judgment (`t<i>_meets` / `t<i>_escalate` noul pairs).
 */
import { describe, expect, it } from "vitest";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Judge } from "pi-typesafe";

import { cardCheck } from "../src/card-check.js";
import { targetsOf } from "../src/targets.js";
import type { Card } from "../src/cards.js";

const CARD: Card = {
	hash: "cardhash1",
	skill: "acme-cleanup",
	builtAt: "2026-11-05T00:00:00.000Z",
	model: "acme/utility-1",
	text: "## torrents_remove\n\n**Allowed without asking when:** the listing shows the torrent at 100% seeding.",
};

const CALL: ToolHookCall = {
	type: "toolCall",
	id: "c1",
	name: "acme-media/torrents_remove",
	arguments: { ids: [7, 9] },
} as ToolHookCall;

/** A judge fake driven by a score map (or a thrown error). */
function fakeJudge(
	responder: (question: string) => number | Error,
): { judge: Judge; questions: string[]; requests: unknown[] } {
	const questions: string[] = [];
	const requests: unknown[] = [];
	const judge: Judge = {
		evaluate: async (request: unknown) => {
			requests.push(request);
			const qs = (request as { questions: Record<string, unknown> }).questions;
			const answers: Record<string, unknown> = {};
			for (const name of Object.keys(qs)) {
				questions.push(name);
				const score = responder(name);
				if (score instanceof Error) throw score;
				answers[name] = { type: "noul", noul: score };
			}
			return {
				answers,
				usage: { input_tokens: 1, output_tokens: 1 },
				model: "acme/decision-1",
				elapsedMs: 1,
			} as never;
		},
	};
	return { judge, questions, requests };
}

describe("targetsOf", () => {
	it("ids [7,9] → [\"7\",\"9\"]", () => {
		expect(targetsOf({ ids: [7, 9] })).toEqual(["7", "9"]);
	});

	it("no array → one canonical target (keys sorted)", () => {
		expect(targetsOf({ b: 1, a: 2 })).toEqual(['{"a":2,"b":1}']);
	});
});

describe("cardCheck", () => {
	it("asks t<i>_meets and t<i>_escalate per target in ONE request, with the brief's instructions", async () => {
		const { judge, questions, requests } = fakeJudge((q) =>
			q.endsWith("_escalate") ? 0.1 : 0.95,
		);
		const result = await cardCheck({
			judge,
			cards: [CARD],
			call: CALL,
			mcpName: "torrents_remove",
			targets: ["7", "9"],
			evidence: ["the listing shows 7 and 9 at 100%"],
			threshold: 0.7,
		});
		expect(requests).toHaveLength(1);
		expect(questions).toEqual(["t0_meets", "t0_escalate", "t1_meets", "t1_escalate"]);
		const request = requests[0] as {
			state: Record<string, unknown>;
			questions: Record<string, { type: string; instructions?: string }>;
		};
		expect(request.questions.t0_meets!.instructions).toBe(
			"Does `evidence` show that target `7` meets a rule in `cards` that allows `acme-media/torrents_remove` without asking?",
		);
		expect(request.questions.t1_escalate!.instructions).toBe(
			"Do `cards` say to escalate instead for target `9`?",
		);
		expect(request.state.cards).toEqual([CARD.text]);
		expect(request.state.evidence).toEqual(["the listing shows 7 and 9 at 100%"]);
		expect(typeof request.state.call).toBe("string");
		expect(result.pass).toBe(true);
		if (result.pass === true) {
			expect(result.scores).toEqual({
				t0_meets: 0.95,
				t0_escalate: 0.1,
				t1_meets: 0.95,
				t1_escalate: 0.1,
			});
		}
	});

	it("a target fails when escalate ≥ threshold even with a high meets score", async () => {
		const { judge } = fakeJudge((q) => (q.endsWith("_escalate") ? 0.9 : 0.95));
		const result = await cardCheck({
			judge,
			cards: [CARD],
			call: CALL,
			targets: ["7"],
			evidence: [],
			threshold: 0.7,
		});
		expect(result.pass).toBe(false);
		if (result.pass === false) {
			expect(result.failing).toEqual(["7"]);
			expect(result.reasons.join(" ")).toContain("t0_escalate");
		}
	});

	it("one failing target of 3 → failing names it, reasons name the lowest-scoring question", async () => {
		const { judge } = fakeJudge((q) => {
			if (q === "t1_meets") return 0.1;
			if (q.endsWith("_escalate")) return 0.2;
			return 0.9;
		});
		const result = await cardCheck({
			judge,
			cards: [CARD],
			call: CALL,
			targets: ["7", "8", "9"],
			evidence: [],
			threshold: 0.7,
		});
		expect(result.pass).toBe(false);
		if (result.pass === false) {
			expect(result.failing).toEqual(["8"]);
			expect(result.reasons.join(" ")).toContain("t1_meets");
		}
	});

	it("a judge throw (bad_answer) → unjudgeable", async () => {
		const { judge } = fakeJudge(() => new Error("bad_answer: malformed"));
		const result = await cardCheck({
			judge,
			cards: [CARD],
			call: CALL,
			targets: ["7"],
			evidence: [],
			threshold: 0.7,
		});
		expect(result.pass).toBe("unjudgeable");
		if (result.pass === "unjudgeable") {
			expect(result.reason).toContain("bad_answer");
		}
	});
});
