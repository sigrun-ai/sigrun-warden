/**
 * Anchored glob matching for warden rules. Globs support `*` ONLY: any
 * run of characters except `/`. Every other character is literal —
 * including `?` and `**` (two adjacent `*` wildcards, no cross-segment
 * meaning). The match is ANCHORED at both ends: `torrents_*` does not
 * match `x/torrents_list`, and `rm*` does not match `xrm`.
 */
export function globToRegExp(pattern) {
    let out = "";
    for (let index = 0; index < pattern.length; index += 1) {
        if (pattern[index] === "*") {
            out += "[^/]*";
        }
        else {
            out += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${out}$`);
}
/** First pattern that matches `value`, or `undefined`. */
export function matchGlob(value, patterns) {
    return patterns.find((pattern) => globToRegExp(pattern).test(value));
}
