import { redact } from "pi-warden";
/**
 * Judge every target against the governing cards. A target passes when
 * `t<i>_meets` ≥ threshold and `t<i>_escalate` < threshold. All pass →
 * `{pass: true, scores}`. Any fail → `{pass: false}` naming the failing
 * targets and the lowest-scoring question per target. A judge failure
 * (a throw, including `bad_answer` surfacing through decisionsJudge) →
 * `{pass: "unjudgeable"}`.
 */
export async function cardCheck(input) {
    const { judge, cards, call, targets, threshold } = input;
    const questions = {};
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
    let answers;
    try {
        const result = await judge.evaluate({
            state: {
                cards: cards.map((card) => card.text),
                call: redact(JSON.stringify(call.arguments)),
                evidence: [...input.evidence],
            },
            questions,
        });
        answers = result.answers;
    }
    catch (error) {
        return {
            pass: "unjudgeable",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    const scores = {};
    for (const [name, answer] of Object.entries(answers)) {
        const noul = answer.noul;
        if (typeof noul === "number")
            scores[name] = noul;
    }
    const failing = [];
    const reasons = [];
    targets.forEach((target, i) => {
        const meets = scores[`t${i}_meets`];
        const escalate = scores[`t${i}_escalate`];
        if (meets === undefined || escalate === undefined) {
            failing.push(target);
            reasons.push(`target ${target}: the decision model returned no score for its questions`);
            return;
        }
        if (meets >= threshold && escalate < threshold)
            return;
        failing.push(target);
        // Name the LOWEST-SCORING of this target's two questions: it is
        // the strongest signal against running.
        const lowest = meets <= escalate ? `t${i}_meets` : `t${i}_escalate`;
        reasons.push(`target ${target}: ${lowest} scored ${scores[lowest].toFixed(2)} against threshold ${threshold}`);
    });
    if (failing.length > 0)
        return { pass: false, failing, reasons };
    return { pass: true, scores };
}
