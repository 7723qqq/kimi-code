import assert from "node:assert";
import { expect, describe, it } from "bun:test";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("regional indicator width regression", () => {
	it("treats partial flag grapheme as full-width to avoid streaming render drift", () => {
		// Repro context:
		// During streaming, "🇨🇳" often appears as an intermediate "🇨" first.
		// If "🇨" is measured as width 1 while terminal renders it as width 2,
		// differential rendering can drift and leave stale characters on screen.
		const partialFlag = "🇨";
		const listLine = "      - 🇨";

		expect(visibleWidth(partialFlag)).toBe(2);
		expect(visibleWidth(listLine)).toBe(10);
	});

	it("wraps intermediate partial-flag list line before overflow", () => {
		// Width 9 cannot fit "      - 🇨" if 🇨 is width 2 (8 + 2 = 10).
		// This must wrap to avoid terminal auto-wrap mismatch.
		const wrapped = wrapTextWithAnsi("      - 🇨", 9);

		expect(wrapped.length).toBe(2);
		expect(visibleWidth(wrapped[0] || "")).toBe(7);
		expect(visibleWidth(wrapped[1] || "")).toBe(2);
	});

	it("treats all regional-indicator singleton graphemes as width 2", () => {
		for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) {
			const regionalIndicator = String.fromCodePoint(cp);
			expect(visibleWidth(regionalIndicator), `Expected ${regionalIndicator} (U+${cp.toString(16).toUpperCase()}) to be width 2`).toBe(2);
		}
	});

	it("keeps full flag pairs at width 2", () => {
		const samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"];
		for (const flag of samples) {
			expect(visibleWidth(flag), `Expected ${flag} to be width 2`).toBe(2);
		}
	});

	it("keeps common streaming emoji intermediates at stable width", () => {
		const samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"];
		for (const sample of samples) {
			expect(visibleWidth(sample), `Expected ${sample} to be width 2`).toBe(2);
		}
	});
});
