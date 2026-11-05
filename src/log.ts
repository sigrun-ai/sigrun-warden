/**
 * The warden hold log: one JSONL file at `paths.state/holds.jsonl`.
 * `prune` keeps hold/block/escalate records for `holds` days and every
 * other action for `calls` days.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface HoldRecord {
	/** ISO timestamp the record was stamped. */
	at: string;
	conversationId: number;
	owner?: string;
	jobId?: string;
	tool: string;
	/** Redacted JSON of the tool call. */
	call: string;
	action:
		| "steer"
		| "hold"
		| "block"
		| "escalate"
		| "release"
		| "allow-judged"
		| "warn";
	scores?: Record<string, number>;
	outcome?: "approved" | "declined" | "replanned" | "escalated" | "abandoned";
}

/** Actions pruned on the longer `holds` retention; the rest ride `calls`. */
const LONG_RETENTION_ACTIONS = new Set<HoldRecord["action"]>([
	"hold",
	"block",
	"escalate",
]);

export class HoldLog {
	readonly #path: string;
	readonly #now: () => Date;

	constructor(path: string, now: () => Date) {
		this.#path = path;
		this.#now = now;
	}

	async #read(): Promise<HoldRecord[]> {
		let text: string;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: HoldRecord[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			records.push(JSON.parse(trimmed) as HoldRecord);
		}
		return records;
	}

	async append(record: HoldRecord): Promise<void> {
		const records = await this.#read();
		records.push(record);
		await this.#write(records);
	}

	/** The newest `n` records, oldest-first within the window. */
	async recent(n: number): Promise<HoldRecord[]> {
		const records = await this.#read();
		return records.slice(-n);
	}

	/**
	 * Drop records older than their action's retention: hold/block/escalate
	 * keep for `retention.holds` days, everything else for `retention.calls`.
	 */
	async prune(retention: { calls: number; holds: number }): Promise<void> {
		const nowMs = this.#now().getTime();
		const callsCutoff = nowMs - retention.calls * 24 * 60 * 60 * 1000;
		const holdsCutoff = nowMs - retention.holds * 24 * 60 * 60 * 1000;
		const records = await this.#read();
		const kept = records.filter((record) => {
			const at = Date.parse(record.at);
			if (!Number.isFinite(at)) return true;
			const cutoff = LONG_RETENTION_ACTIONS.has(record.action)
				? holdsCutoff
				: callsCutoff;
			return at >= cutoff;
		});
		if (kept.length !== records.length) await this.#write(kept);
	}

	async #write(records: readonly HoldRecord[]): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const text = records.map((record) => JSON.stringify(record)).join("\n");
		await writeFile(this.#path, text === "" ? "" : `${text}\n`, "utf8");
	}
}
