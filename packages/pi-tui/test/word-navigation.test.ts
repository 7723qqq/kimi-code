import { expect, describe, it } from "bun:test";
import { findWordBackward, findWordForward } from "../src/word-navigation.ts";

describe("findWordBackward", () => {
	it("basic words: hello world", () => {
		const text = "hello world";
		expect(findWordBackward(text, 11)).toBe(6);
		expect(findWordBackward(text, 6)).toBe(0);
	});

	it("dotted: foo.bar", () => {
		const text = "foo.bar";
		expect(findWordBackward(text, 7)).toBe(4);
		expect(findWordBackward(text, 4)).toBe(3);
		expect(findWordBackward(text, 3)).toBe(0);
	});

	it("colon: foo:bar", () => {
		const text = "foo:bar";
		expect(findWordBackward(text, 7)).toBe(4);
		expect(findWordBackward(text, 4)).toBe(3);
		expect(findWordBackward(text, 3)).toBe(0);
	});

	it("path: path/to/file", () => {
		const text = "path/to/file";
		expect(findWordBackward(text, 12)).toBe(8);
		expect(findWordBackward(text, 8)).toBe(7);
		// "/to" is one word-like segment with "/" as punctuation boundary
		expect(findWordBackward(text, 7)).toBe(5);
		expect(findWordBackward(text, 5)).toBe(4);
		expect(findWordBackward(text, 4)).toBe(0);
	});

	it("CJK mixed", () => {
		const text = "你好世界 test";
		expect(findWordBackward(text, text.length)).toBe(5);
		// Intl.Segmenter treats each CJK char as a separate word-like segment
		expect(findWordBackward(text, 5)).toBe(2);
		expect(findWordBackward(text, 2)).toBe(0);
	});

	it("whitespace at boundaries", () => {
		const text = "  hello  ";
		expect(findWordBackward(text, 9)).toBe(2);
		expect(findWordBackward(text, 2)).toBe(0);
	});

	it("punctuation run: foo...bar", () => {
		const text = "foo...bar";
		expect(findWordBackward(text, 9)).toBe(6);
		expect(findWordBackward(text, 6)).toBe(3);
		expect(findWordBackward(text, 3)).toBe(0);
	});

	it("cursor at 0 returns 0", () => {
		expect(findWordBackward("hello", 0)).toBe(0);
	});
});

describe("findWordForward", () => {
	it("basic words: hello world", () => {
		const text = "hello world";
		expect(findWordForward(text, 0)).toBe(5);
		expect(findWordForward(text, 5)).toBe(11);
	});

	it("dotted: foo.bar", () => {
		const text = "foo.bar";
		expect(findWordForward(text, 0)).toBe(3);
		expect(findWordForward(text, 3)).toBe(4);
		expect(findWordForward(text, 4)).toBe(7);
	});

	it("colon: foo:bar", () => {
		const text = "foo:bar";
		expect(findWordForward(text, 0)).toBe(3);
		expect(findWordForward(text, 3)).toBe(4);
		expect(findWordForward(text, 4)).toBe(7);
	});

	it("path: path/to/file", () => {
		const text = "path/to/file";
		expect(findWordForward(text, 0)).toBe(4);
		expect(findWordForward(text, 4)).toBe(5);
		expect(findWordForward(text, 5)).toBe(7);
		expect(findWordForward(text, 7)).toBe(8);
		expect(findWordForward(text, 8)).toBe(12);
	});

	it("CJK mixed", () => {
		const text = "你好世界 test";
		const firstEnd = findWordForward(text, 0);
		expect(firstEnd > 0).toBeTruthy();
		expect(firstEnd <= 4).toBeTruthy();
		// Walk to end
		let pos = 0;
		while (pos < text.length) {
			const next = findWordForward(text, pos);
			if (next === pos) break;
			pos = next;
		}
		expect(pos).toBe(text.length);
	});

	it("whitespace at boundaries", () => {
		const text = "  hello  ";
		expect(findWordForward(text, 0)).toBe(7);
		expect(findWordForward(text, 7)).toBe(9);
	});

	it("punctuation run: foo...bar", () => {
		const text = "foo...bar";
		expect(findWordForward(text, 0)).toBe(3);
		expect(findWordForward(text, 3)).toBe(6);
		expect(findWordForward(text, 6)).toBe(9);
	});

	it("cursor at end returns end", () => {
		expect(findWordForward("hello", 5)).toBe(5);
	});
});

describe("atomic segments", () => {
	const marker = "[paste #1 +5 lines]";
	const text = `hello ${marker} world`;
	const isAtomic = (s: string) => s === marker;

	// The functions slice text before calling segment(), so we map each expected
	// substring to its pre-split segments.
	const segmentMap = new Map<string, Intl.SegmentData[]>([
		[
			text, // full text (not used but for clarity)
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		[
			// backward from end: slice(0, 31) = full text
			text.slice(0, text.length),
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		[
			// backward from 26: slice(0, 26) = "hello [paste #1 +5 lines] "
			text.slice(0, 26),
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
			],
		],
		[
			// forward from 6: slice(6) = "[paste #1 +5 lines] world"
			text.slice(6),
			[
				{ segment: marker, index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 19, input: text, isWordLike: false },
				{ segment: "world", index: 20, input: text, isWordLike: true },
			],
		],
	]);

	const opts = {
		segment: (input: string) => segmentMap.get(input) ?? [],
		isAtomicSegment: isAtomic,
	};

	it("backward skips word then stops before atomic marker", () => {
		expect(findWordBackward(text, text.length, opts)).toBe(26);
	});

	it("backward skips whitespace then atomic marker as one unit", () => {
		expect(findWordBackward(text, 26, opts)).toBe(6);
	});

	it("forward skips atomic marker as one unit", () => {
		expect(findWordForward(text, 6, opts)).toBe(6 + marker.length);
	});
});
