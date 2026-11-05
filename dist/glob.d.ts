/**
 * Anchored glob matching for warden rules. Globs support `*` ONLY: any
 * run of characters except `/`. Every other character is literal —
 * including `?` and `**` (two adjacent `*` wildcards, no cross-segment
 * meaning). The match is ANCHORED at both ends: `torrents_*` does not
 * match `x/torrents_list`, and `rm*` does not match `xrm`.
 */
export declare function globToRegExp(pattern: string): RegExp;
/** First pattern that matches `value`, or `undefined`. */
export declare function matchGlob(value: string, patterns: readonly string[]): string | undefined;
