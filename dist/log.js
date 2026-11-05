/**
 * The warden hold log: one JSONL file at `paths.state/holds.jsonl`.
 * `prune` keeps hold/block/escalate records for `holds` days and every
 * other action for `calls` days.
 */
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            if (trimmed === "")
                continue;
            try {
                records.push(JSON.parse(trimmed));
            }
            catch {
                // A torn trailing line after a crash must not brick the log.
                console.warn(`holds log: skipping unparseable line ${index + 1}`);
            }
        }
        return records;
    }
    async append(record) {
        await mkdir(dirname(this.#path), { recursive: true });
        // A crash can leave a torn trailing line without its newline; prefix
        // one so the new record does not merge into the torn fragment.
        const handle = await open(this.#path, "a+");
        try {
            let prefix = "";
            const { size } = await handle.stat();
            if (size > 0) {
                const last = Buffer.alloc(1);
                await handle.read(last, 0, 1, size - 1);
                if (last[0] !== 0x0a)
                    prefix = "\n";
            }
            await handle.appendFile(`${prefix}${JSON.stringify(record)}\n`, "utf8");
        }
        finally {
            await handle.close();
        }
    }
    /** The newest `n` records, oldest-first within the window. */
    async recent(n) {
        if (n <= 0)
            return [];
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
    /**
     * Rewrite the whole log (prune only). Written to a temp file and
     * renamed over the log; a concurrent `append` may still lose the
     * rename race, so prune-vs-append races are accepted with a warn.
     */
    async #write(records) {
        await mkdir(dirname(this.#path), { recursive: true });
        const text = records.map((record) => JSON.stringify(record)).join("\n");
        const tmp = `${this.#path}.tmp`;
        await writeFile(tmp, text === "" ? "" : `${text}\n`, "utf8");
        await rename(tmp, this.#path);
    }
}
