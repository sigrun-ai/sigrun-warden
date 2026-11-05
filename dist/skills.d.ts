import type { EntryRecord } from "@earendil-works/pi-durable";
export interface SkillSeen {
    name: string;
    location?: string;
    body: string;
    /** sha256 hex of the body. */
    hash: string;
}
export interface SkillTag {
    name: string;
    location?: string;
}
/** Extract `<skill name="…" location="…">` tags from expanded text. */
export declare function skillTagsInText(text: string): SkillTag[];
/**
 * Collect the skills the run saw, newest first, deduped by body hash.
 * Input `entries` may be in either order; the newest copy of a body
 * wins and the result sorts by first-seen recency (the entry id of
 * each body's newest sighting, descending).
 */
export declare function skillsInRun(entries: readonly EntryRecord[]): SkillSeen[];
export interface SkillBlock {
    name: string;
    location?: string;
    body: string;
}
/**
 * Every `<skill name="…">…</skill>` block in the text, in order. The
 * body is trimmed of one surrounding newline pair and of core's
 * `References are relative to …` preamble, so it equals the SKILL.md
 * text the other channels capture.
 */
export declare function skillBlocksInText(text: string): SkillBlock[];
