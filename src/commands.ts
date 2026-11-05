/**
 * The `/warden` slash command (warden spec §3.4): cards list/show, and
 * `--rebuild` from the newest body seen in this conversation's run.
 * Answers are notices (the ExtensionCommandContribution contract).
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	ExtensionCommandContribution,
	SigrunHost,
} from "@sigrun/sigrun/extension";

import { buildCard, CardStore, type Card } from "./cards.js";
import { parseSettings } from "./settings.js";
import { skillsInRun } from "./skills.js";

const RUN_PAGE = 500;

/** Build the warden's slash commands over the host (one per factory). */
export function createWardenCommands(
	host: SigrunHost,
): readonly ExtensionCommandContribution[] {
	return [
		{
			name: "warden",
			description: "Skill cards: list, show, and rebuild",
			args: "cards | card <skill> [--rebuild]",
			run: async (ctx) => ({
				notice: await runWardenCommands(host, ctx.conversationId, ctx.args),
			}),
		},
	];
}

async function runWardenCommands(
	host: SigrunHost,
	conversationId: ConversationId,
	args: string,
): Promise<string> {
	const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
	const [sub, ...rest] = words;
	if (sub === "cards") return cardsList(host);
	if (sub === "card") {
		const rebuild = rest.includes("--rebuild");
		const skill = rest.find((word) => word !== "--rebuild");
		if (skill === undefined) return "usage: /warden card <skill> [--rebuild]";
		if (rebuild) return cardRebuild(host, conversationId, skill);
		return cardShow(host, skill);
	}
	return "usage: /warden cards | /warden card <skill> [--rebuild]";
}

async function cardsList(host: SigrunHost): Promise<string> {
	const store = new CardStore(host.stores.paths.data);
	const cards = await store.list();
	if (cards.length === 0) return "no cards";
	return cards.map((card) => cardLine(card)).join("\n");
}

function cardLine(card: Card): string {
	return `${card.skill} · ${card.hash.slice(0, 8)} · ${card.builtAt} · ${card.model}`;
}

async function cardShow(host: SigrunHost, skill: string): Promise<string> {
	const store = new CardStore(host.stores.paths.data);
	const cards = (await store.list()).filter((card) => card.skill === skill);
	if (cards.length === 0) return `no card for ${skill}`;
	return cards[0]!.text;
}

async function cardRebuild(
	host: SigrunHost,
	conversationId: ConversationId,
	skill: string,
): Promise<string> {
	const page = await host.conversations.entries(
		conversationId,
		{ order: "ascending" },
		RUN_PAGE,
		undefined,
	);
	const seen = skillsInRun(page.items as never);
	const copy = seen.find((entry) => entry.name === skill);
	if (copy === undefined) {
		return `no copy of ${skill} in this conversation; load it first`;
	}
	const raw = await host.stores.settings.get();
	const settings = parseSettings(raw, (message) => console.warn(message));
	const card = await buildCard(host, copy, settings);
	if (card === undefined) return `card build failed for ${skill}`;
	return card.text;
}
