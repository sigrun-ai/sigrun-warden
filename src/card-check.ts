/**
 * The per-target card check (warden spec §3.2, Task 14): a CLEARED
 * destructive job call runs autonomously only when the decision model
 * confirms, for EVERY target, that the run's evidence shows the target
 * meets a governing card's allow rule and no card says to escalate for
 * it. One DecisionRequest carries two noul questions per target:
 * `t<i>_meets` and `t<i>_escalate`.
 */
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { Judge, NoulQuestion } from "pi-typesafe";
import { redact } from "pi-warden";

import type { Card } from "./cards.js";

export type CardCheckResult =
	| { pass: true; scores: Record<string, number> }
	| { pass: false; failing: readonly string[]; reasons: readonly string[] }
	| { pass: "unjudgeable"; reason: string };

export interface CardCheckInput {
	judge: Judge;
	/** The governing card texts (each card's `text`). */
	cards: readonly Card[];
	call: ToolHookCall;
	/** The tool's MCP name when it is an MCP tool (the card's heading). */
	mcpName?: string;
	targets: readonly string[];
	/** This run's redacted evidence texts (evidenceFor). */
	evidence: readonly string[];
	/** The card threshold (settings.thresholds.card). */
	threshold: number;
}

/**
 * Judge every target against the governing cards. A target passes when
 * `t<i>_meets` ≥ threshold and `t<i>_escalate` < threshold. All pass →
 * `{pass: true, scores}`. Any fail → `{pass: false}` naming the failing
 * targets and the lowest-scoring question per target. A judge failure
 * (a throw, including `bad_answer` surfacing through decisionsJudge) →
 * `{pass: "unjudgeable"}`.
 */
export async function cardCheck(input: CardCheckInput): Promise<CardCheckResult> {
	const { judge, cards, call, targets, threshold } = input;
	const questions: Record<string, NoulQuestion> = {};
	targets.forEach((target, i) => {
		questions[`t${i}_meets`] = {
			type: "noul",
			instructions: `Does \`evidence\` show that target \`${target}\` meets a rule in \`cards\` that allows \`${call.name}\` without asking?`,
		};
		questions[`t${i}_escalate`] = {
			type: "noul",
			instructions: `Do \`cards\` say to escalate instead for target \`${target}\`?`,
		};
	});

	let answers: Record<string, unknown>;
	try {
		const result = await judge.evaluate({
			state: {
				cards: cards.map((card) => card.text),
				call: redact(JSON.stringify(call.arguments)),
				evidence: [...input.evidence],
			},
			questions,
		});
		answers = result.answers as Record<string, unknown>;
	} catch (error) {
		return {
			pass: "unjudgeable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	const scores: Record<string, number> = {};
	for (const [name, answer] of Object.entries(answers)) {
		const noul = (answer as { type?: unknown; noul?: unknown }).noul;
		if (typeof noul === "number") scores[name] = noul;
	}

	const failing: string[] = [];
	const reasons: string[] = [];
	targets.forEach((target, i) => {
		const meets = scores[`t${i}_meets`];
		const escalate = scores[`t${i}_escalate`];
		if (meets === undefined || escalate === undefined) {
			failing.push(target);
			reasons.push(
				`target ${target}: the decision model returned no score for its questions`,
			);
			return;
		}
		if (meets >= threshold && escalate < threshold) return;
		failing.push(target);
		// Name the LOWEST-SCORING of this target's two questions: it is
		// the strongest signal against running.
		const lowest = meets <= escalate ? `t${i}_meets` : `t${i}_escalate`;
		reasons.push(
			`target ${target}: ${lowest} scored ${scores[lowest]!.toFixed(2)} against threshold ${threshold}`,
		);
	});
	if (failing.length > 0) return { pass: false, failing, reasons };
	return { pass: true, scores };
}
