/**
 * The warden hold log: one JSONL file at `paths.state/holds.jsonl`.
 * `prune` keeps hold/block/escalate records for `holds` days and every
 * other action for `calls` days.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
/** Actions pruned on the longer `holds` retention; the rest ride `calls`. */
const LONG_RETENTION_ACTIONS = new Set([
    "hold",
    "block",
    "escalate",
]);
export class HoldLog {
    #path;
    #now;
    constructor(path, now) {
        this.#path = path;
        this.#now = now;
    }
    async #read() {
        let text;
        try {
            text = await readFile(this.#path, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
        const records = [];
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "")
                continue;
            records.push(JSON.parse(trimmed));
        }
        return records;
    }
    async append(record) {
        const records = await this.#read();
        records.push(record);
        await this.#write(records);
    }
    /** The newest `n` records, oldest-first within the window. */
    async recent(n) {
        const records = await this.#read();
        return records.slice(-n);
    }
    /**
     * Drop records older than their action's retention: hold/block/escalate
     * keep for `retention.holds` days, everything else for `retention.calls`.
     */
    async prune(retention) {
        const nowMs = this.#now().getTime();
        const callsCutoff = nowMs - retention.calls * 24 * 60 * 60 * 1000;
        const holdsCutoff = nowMs - retention.holds * 24 * 60 * 60 * 1000;
        const records = await this.#read();
        const kept = records.filter((record) => {
            const at = Date.parse(record.at);
            if (!Number.isFinite(at))
                return true;
            const cutoff = LONG_RETENTION_ACTIONS.has(record.action)
                ? holdsCutoff
                : callsCutoff;
            return at >= cutoff;
        });
        if (kept.length !== records.length)
            await this.#write(kept);
    }
    async #write(records) {
        await mkdir(dirname(this.#path), { recursive: true });
        const text = records.map((record) => JSON.stringify(record)).join("\n");
        await writeFile(this.#path, text === "" ? "" : `${text}\n`, "utf8");
    }
}
