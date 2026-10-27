import { expect, describe, it } from "bun:test";
import { asciiVisibleWidth, normalizeTerminalOutput, truncateToWidth, visibleWidth } from "../src/utils.ts";

describe("truncateToWidth", () => {
	it("keeps output within width for very large unicode input", () => {
		const text = "🙂界".repeat(100_000);
		const truncated = truncateToWidth(text, 40, "…");

		expect(visibleWidth(truncated) <= 40).toBeTruthy();
		expect(truncated.endsWith("…\x1b[0m")).toBe(true);
	});

	it("preserves ANSI styling for kept text and resets before and after ellipsis", () => {
		const text = `\x1b[31m${"hello ".repeat(1000)}\x1b[0m`;
		const truncated = truncateToWidth(text, 20, "…");

		expect(visibleWidth(truncated) <= 20).toBeTruthy();
		expect(truncated.includes("\x1b[31m")).toBe(true);
		expect(truncated.endsWith("\x1b[0m…\x1b[0m")).toBe(true);
	});

	it("closes a BEL-terminated OSC 8 link when truncating its label", () => {
		const open = "\x1b]8;;https://example.com\x07";
		const close = "\x1b]8;;\x07";
		const text = `${open}some-longer-label-here${close}`;

		expect(truncateToWidth(text, 15)).toBe(`${open}some-longer-${close}\x1b[0m...\x1b[0m`);
	});

	it("handles malformed ANSI escape prefixes without hanging", () => {
		const text = `abc\x1bnot-ansi ${"🙂".repeat(1000)}`;
		const truncated = truncateToWidth(text, 20, "…");

		expect(visibleWidth(truncated) <= 20).toBeTruthy();
	});

	it("clips wide ellipsis safely and brackets it with resets", () => {
		expect(truncateToWidth("abcdef", 1, "🙂")).toBe("");
		expect(truncateToWidth("abcdef", 2, "🙂")).toBe("\x1b[0m🙂\x1b[0m");
		expect(visibleWidth(truncateToWidth("abcdef", 2, "🙂")) <= 2).toBeTruthy();
	});

	it("returns the original text when it already fits even if ellipsis is too wide", () => {
		expect(truncateToWidth("a", 2, "🙂")).toBe("a");
		expect(truncateToWidth("界", 2, "🙂")).toBe("界");
	});

	it("pads truncated output to requested width", () => {
		const truncated = truncateToWidth("🙂界🙂界🙂界", 8, "…", true);
		expect(visibleWidth(truncated)).toBe(8);
	});

	it("adds a trailing reset when truncating without an ellipsis", () => {
		const truncated = truncateToWidth(`\x1b[31m${"hello".repeat(100)}`, 10, "");
		expect(visibleWidth(truncated) <= 10).toBeTruthy();
		expect(truncated.endsWith("\x1b[0m")).toBe(true);
	});

	it("keeps a contiguous prefix instead of skipping a wide grapheme and resuming later", () => {
		const truncated = truncateToWidth("🙂\t界 \x1b_abc\x07", 7, "…", true);
		expect(truncated).toBe("🙂\t\x1b[0m…\x1b[0m ");
	});
});

describe("visibleWidth", () => {
	it("counts tabs inline and skips ANSI inline", () => {
		expect(visibleWidth("\t\x1b[31m界\x1b[0m")).toBe(5);
	});

	it("counts Indic conjunct spacing code points within grapheme clusters", () => {
		expect(visibleWidth("र्क")).toBe(2);
		expect(visibleWidth("नेटवर्क")).toBe(5);
		expect(visibleWidth("सर्वाधिकार सुरक्षित। ऑर्डर पर क्लिक करें")).toBe(33);
		expect(visibleWidth("র্ক")).toBe(2);
		expect(visibleWidth("ર્ક")).toBe(2);
		expect(visibleWidth("ର୍କ")).toBe(2);
		expect(visibleWidth("ర్క")).toBe(2);
		expect(visibleWidth("ര്‍ക")).toBe(2);
	});

	it("keeps ordinary combining marks zero-width", () => {
		expect(visibleWidth("e\u0301")).toBe(1);
		expect(visibleWidth("čřžůú")).toBe(5);
		expect(visibleWidth("שָׁ")).toBe(1);
		expect(visibleWidth("بّ")).toBe(1);
		expect(visibleWidth("རྐ")).toBe(1);
		expect(visibleWidth("ᜠ᜴")).toBe(1);
		expect(visibleWidth("가〮")).toBe(2);
		expect(visibleWidth("가〯")).toBe(2);
	});

	it("keeps CJK and Japanese width accounting unchanged", () => {
		expect(visibleWidth("网络")).toBe(4);
		expect(visibleWidth("ネットワーク")).toBe(12);
		expect(visibleWidth("が")).toBe(2);
		expect(visibleWidth("か\u3099")).toBe(2);
	});

	it("counts Myanmar marks that terminals allocate cells for", () => {
		expect(visibleWidth("ကာ")).toBe(2);
		expect(visibleWidth("ကေ")).toBe(2);
		expect(visibleWidth("က်")).toBe(2);
		expect(visibleWidth("ကျ")).toBe(2);
		expect(visibleWidth("ကြ")).toBe(2);
		expect(visibleWidth("ကဳ")).toBe(2);
		expect(visibleWidth("ကဴ")).toBe(2);
		expect(visibleWidth("ကဵ")).toBe(2);
		expect(visibleWidth("ကး")).toBe(2);
		expect(visibleWidth("ကို")).toBe(1);
		expect(visibleWidth("က္")).toBe(1);
	});

	it("keeps Thai and Lao AM clusters at their normal cell width", () => {
		expect(visibleWidth("ำ")).toBe(1);
		expect(visibleWidth("ຳ")).toBe(1);
		expect(visibleWidth("กำ")).toBe(2);
		expect(visibleWidth("ກຳ")).toBe(2);
	});

	it("normalizes Thai and Lao AM vowels only for terminal output", () => {
		expect(normalizeTerminalOutput("ำ")).toBe("ํา");
		expect(normalizeTerminalOutput("ຳ")).toBe("ໍາ");
		expect(visibleWidth(normalizeTerminalOutput("ำabc"))).toBe(visibleWidth("ำabc"));
		expect(visibleWidth(normalizeTerminalOutput("ຳabc"))).toBe(visibleWidth("ຳabc"));
	});
});

describe("asciiVisibleWidth", () => {
	it("measures ASCII lines and skips ANSI sequences", () => {
		expect(asciiVisibleWidth("hello", 80)).toBe(5);
		expect(asciiVisibleWidth("\x1b[31mhello\x1b[0m", 80)).toBe(5);
	});

	it("returns undefined for non-ASCII, control chars, or lone ESC", () => {
		expect(asciiVisibleWidth("你好", 80)).toBe(undefined);
		expect(asciiVisibleWidth("a\tb", 80)).toBe(undefined);
		expect(asciiVisibleWidth("a\x1b", 80)).toBe(undefined);
	});

	it("early-exits once width exceeds the limit", () => {
		const result = asciiVisibleWidth("x".repeat(100), 4);
		expect(result !== undefined && result > 4).toBeTruthy();
	});
});
