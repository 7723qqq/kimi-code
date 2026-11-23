import { describe, it, expect } from "bun:test";
import { visibleWidth } from "../src/utils.ts";

describe("visibleWidth", () => {
	it("measures styled ASCII without counting escape sequences", () => {
		expect(visibleWidth("\x1b[38;5;4mhello\x1b[39m world")).toBe(11);
		expect(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(4);
		expect(visibleWidth("\x1b]133;A\x1b\\prompt")).toBe(6);
		expect(visibleWidth("\x1b_pi:c\x07cursor")).toBe(6);
	});

	it("counts tabs as three columns in styled text", () => {
		expect(visibleWidth("\x1b[1ma\tb\x1b[22m")).toBe(5);
	});

	it("measures styled non-ASCII text", () => {
		expect(visibleWidth("\x1b[31m日本\x1b[39m ok")).toBe(7);
		expect(visibleWidth("\x1b[31m─→\x1b[39m")).toBe(2);
	});

	it("treats unterminated escape sequences as zero-width control characters", () => {
		expect(visibleWidth("\x1b[31")).toBe(3);
		expect(visibleWidth("a\x1b")).toBe(1);
	});
});
