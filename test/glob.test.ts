import { describe, expect, it } from "vitest";

import { globToRegExp, matchGlob } from "../src/glob.js";

describe("globToRegExp", () => {
	it("`*` matches within a segment", () => {
		expect(globToRegExp("acme-media/torrents_*").test("acme-media/torrents_add")).toBe(true);
		expect(globToRegExp("torrents_*").test("torrents_list")).toBe(true);
		expect(globToRegExp("torrents_*").test("torrents_")).toBe(true);
	});

	it("`*` does not cross `/`", () => {
		expect(globToRegExp("acme-*").test("acme-media/torrents_add")).toBe(false);
		expect(globToRegExp("*/add").test("acme-media/torrents_add")).toBe(false);
	});

	it("is anchored at both ends", () => {
		expect(globToRegExp("torrents_*").test("x/torrents_list")).toBe(false);
		expect(globToRegExp("rm*").test("xrm")).toBe(false);
		expect(globToRegExp("rm*").test("orm")).toBe(false);
		expect(globToRegExp("rm*").test("rm -rf /")).toBe(false);
	});

	it("`?` and `**` are literal characters, not wildcards", () => {
		// `?` matches only a literal `?`.
		expect(globToRegExp("a?c").test("abc")).toBe(false);
		expect(globToRegExp("a?c").test("a?c")).toBe(true);
		// `**` is two ordinary `*` wildcards: no cross-segment meaning.
		expect(globToRegExp("a**c").test("a/b/c")).toBe(false);
		expect(globToRegExp("a**c").test("axxc")).toBe(true);
	});

	it("escapes regex metacharacters", () => {
		expect(globToRegExp("a.c+d").test("a.c+d")).toBe(true);
		expect(globToRegExp("a.c+d").test("axc+d")).toBe(false);
	});
});

describe("matchGlob", () => {
	it("returns the first matching pattern", () => {
		expect(matchGlob("acme-media/torrents_add", ["x*", "acme-*", "acme-media/*"])).toBe("acme-media/*");
	});
	it("returns undefined when nothing matches", () => {
		expect(matchGlob("read", ["bash*", "write"])).toBeUndefined();
	});
});
