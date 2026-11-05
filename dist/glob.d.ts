/**
 * Anchored glob matching for warden rules. Globs support `*` ONLY (any
 * run of characters except `/`), `?` (one character), and `**` (any run
 * of segments); every other character is literal. The match is ANCHORED
 * at both ends: `torrents_*` does not match `x/torrents_list`. This is
 * the same glob language pi-warden uses for its own rule patterns, minus
 * its project-relative `(?:.*\/)?` prefix — sigrun tool arguments are
 * not project-relative paths, so the anchor is strict.
 */
export declare function globToRegExp(pattern: string): RegExp;
/** First pattern that matches `value`, or `undefined`. */
export declare function matchGlob(value: string, patterns: readonly string[]): string | undefined;
