/**
 * Anchored glob matching for warden rules. Globs support `*` ONLY (any
 * run of characters except `/`), `?` (one character), and `**` (any run
 * of segments); every other character is literal. The match is ANCHORED
 * at both ends: `torrents_*` does not match `x/torrents_list`. This is
 * the same glob language pi-warden uses for its own rule patterns, minus
 * its project-relative `(?:.*\/)?` prefix — sigrun tool arguments are
 * not project-relative paths, so the anchor is strict.
 */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let index = 0; index < pattern.length; ) {
		if (pattern.startsWith("**/", index)) {
			out += "(?:.*/)?";
			index += 3;
		} else if (pattern.startsWith("**", index)) {
			out += ".*";
			index += 2;
		} else if (pattern[index] === "*") {
			out += "[^/]*";
			index += 1;
		} else if (pattern[index] === "?") {
			out += "[^/]";
			index += 1;
		} else {
			out += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			index += 1;
		}
	}
	return new RegExp(`^${out}$`);
}

/** First pattern that matches `value`, or `undefined`. */
export function matchGlob(
	value: string,
	patterns: readonly string[],
): string | undefined {
	return patterns.find((pattern) => globToRegExp(pattern).test(value));
}
