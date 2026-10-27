import assert from "node:assert";
import { expect, describe, it } from "bun:test";
import { compositeTuiLine } from "../src/tui.ts";
import { extractSegments, sliceByColumn, visibleWidth } from "../src/utils.ts";

describe("overlay CJK boundary regression", () => {
	it("excludes a wide grapheme from before when overlay starts inside it", () => {
		const segments = extractSegments("abcd让EFGH", 5, 9, 11, true);

		expect(segments.before).toBe("abcd");
		expect(segments.beforeWidth).toBe(4);
		expect(visibleWidth(segments.before)).toBe(segments.beforeWidth);
		expect(segments.after).toBe("H");
		expect(segments.afterWidth).toBe(1);
	});

	it("keeps ASCII before-segment behavior at the same boundary", () => {
		const segments = extractSegments("abcdG EFGH", 5, 9, 11, true);

		expect(segments.before).toBe("abcdG");
		expect(segments.beforeWidth).toBe(5);
		expect(visibleWidth(segments.before)).toBe(segments.beforeWidth);
	});

	it("composites an overlay at the requested column when it starts inside a wide grapheme", () => {
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 5, 4, 20);
		const prefix = sliceByColumn(out, 0, 5, true);
		const overlay = sliceByColumn(out, 5, 4, true);

		expect(out.includes("让")).toBe(false);
		expect(visibleWidth(out)).toBe(20);
		expect(visibleWidth(prefix)).toBe(5);
		expect(visibleWidth(overlay)).toBe(4);
		expect(overlay.includes("│XX│")).toBe(true);
	});

	it("composites an overlay when it starts at a wide grapheme boundary", () => {
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 4, 4, 20);
		const overlay = sliceByColumn(out, 4, 4, true);

		expect(out.includes("让")).toBe(false);
		expect(visibleWidth(out)).toBe(20);
		expect(visibleWidth(overlay)).toBe(4);
		expect(overlay.includes("│XX│")).toBe(true);
	});
});
