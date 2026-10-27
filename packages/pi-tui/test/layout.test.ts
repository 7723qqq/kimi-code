import assert from "node:assert";
import { expect, describe, it } from "bun:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		expect(frame.root.children.map((child) => child.rect.height)).toStrictEqual([1, 3]);
		expect(visibleLines(frame.lines)).toStrictEqual(["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		expect(renderCount).toBe(1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		expect(visibleLines(frame.lines)).toStrictEqual(["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		expect(frame.root.children.map((child) => child.rect.height)).toStrictEqual([1, 3]);
		expect(visibleLines(frame.lines)).toStrictEqual(["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		expect(visibleLines(frame.lines)).toStrictEqual([
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		expect(stack.render(10).map((line) => line.trimEnd())).toStrictEqual(["one", "", "two"]);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		expect(frame.lines[2]?.includes("y=0,h=34,r=1")).toBeTruthy();
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		expect(visibleLines(frame.lines)).toStrictEqual(["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		expect(visibleLines(frame.lines)).toStrictEqual(["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		expect(scrollView.scrollTop).toBe(3);
		expect(scrollView.isFollowingEnd).toBe(true);

		expect(scrollView.scrollBy(-2)).toBe(0);
		expect(scrollView.scrollTop).toBe(1);
		expect(scrollView.isFollowingEnd).toBe(false);
		expect(scrollView.scrollBy(-3)).toBe(-2);
		expect(scrollView.scrollTop).toBe(0);
		expect(scrollView.scrollBy(10)).toBe(7);
		expect(scrollView.scrollTop).toBe(3);
		expect(scrollView.isFollowingEnd).toBe(true);
	});

	it("does not schedule renders for layout-driven scroll changes", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), { follow: "end" });
		let calls = 0;
		renderLayoutFrame(scrollView, 10, 3, () => {
			calls += 1;
		});
		expect(scrollView.scrollTop).toBe(3);
		expect(calls).toBe(0);
	});

	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const trackColor = "\x1b[38;5;2m";
		const thumbColor = "\x1b[38;5;1m";
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		let lines = render();
		expect(visible(lines)).toStrictEqual(sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		expect(visible(lines)).toStrictEqual(["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		expect(lines.map((line) => line.includes(trackColor))).toStrictEqual([true, false, false, true]);
		expect(lines.map((line) => line.includes(thumbColor))).toStrictEqual([false, true, true, false]);

		scrollView.setScrollbarActive(true);
		lines = render();
		expect(visible(lines)).toStrictEqual(["abcde│", "abcde█", "abcde█", "abcde│"]);
		expect(lines.map((line) => line.includes(thumbColor))).toStrictEqual([false, true, true, false]);
		expect(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor)).toBeTruthy();

		scrollView.setScrollbarActive(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		expect(visible(lines)).toStrictEqual(sourceLines.slice(2, 6));

		scrollView.scrollToEnd();
		lines = render();
		expect(visible(lines)).toStrictEqual(["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		scrollView.scrollToStart();
		lines = render();
		expect(visible(lines)[0]).toBe("abcd ┃");

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		expect(followed.scrollTop).toBe(4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		expect(followed.scrollTop).toBe(5);
		expect(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line)))).toBeTruthy();

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		expect(renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line)))).toBeTruthy();

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		expect(alwaysFittingFrame.root.children[0]?.rect.width).toBe(5);
		expect(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃"))).toBeTruthy();

		const alwaysOverflowing = new ScrollView(content, {
			scrollbar: "always",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		expect(alwaysOverflowingFrame.root.children[0]?.rect.width).toBe(5);
		expect(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length).toBe(2);
		expect(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length).toBe(2);
		for (const line of alwaysOverflowingFrame.lines) {
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			expect(reservedColumnResetIndex > line.lastIndexOf(contentBackground)).toBeTruthy();
		}

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarThumbStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) =>
				stripTerminalSequences(line).endsWith("┃"),
			).length;
		};
		expect(thumbHeightFor(21)).toBe(19);
		expect(thumbHeightFor(40)).toBe(10);
		expect(thumbHeightFor(100)).toBe(4);
		expect(thumbHeightFor(400)).toBe(2);
	});

	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		const background = "\x1b[42m";
		const borderForeground = "\x1b[31m";
		const content = {
			render: (width: number) =>
				Array.from(
					{ length: 8 },
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => text,
			scrollbarThumbStyle: (text) => text,
		});
		renderLayoutFrame(scrollView, 6, 4, () => {});
		scrollView.scrollBy(1);
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		expect(frame.lines.map(stripTerminalSequences)).toStrictEqual(["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		for (const line of frame.lines) {
			expect(line.includes(background)).toBeTruthy();
			expect(!line.includes(borderForeground)).toBeTruthy();
			expect(line.includes(`\x1b[0m\x1b]8;;\x07${background}`)).toBeTruthy();
		}
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		expect(visibleLines(always.lines)).toStrictEqual(["12345┃", "6    ┃"]);
		expect(always.root.children[0]?.rect.width).toBe(6);
		expect(always.root.children[0]?.children[0]?.rect.width).toBe(5);

		scrollView.setScrollbar("hidden");
		expect(render().root.children[0]?.children[0]?.rect.width).toBe(6);
		expect(scrollView.isScrollbarVisible).toBe(false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		expect(inner.viewportHeight).toBe(2);
		expect(outer.scrollBy(10)).toBe(9);
		expect(outer.scrollTop).toBe(1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		expect(first.root.children[0]?.lines?.length).toBe(1);
		expect(second.root.children[0]?.lines?.length).toBe(3);
	});

	it("renders component nesting below the layout depth cap", () => {
		const depth = 100;
		let root: VStack = new VStack([{ component: new Text("x", 0, 0), basis: 1 }]);
		for (let i = 1; i < depth; i++) root = new VStack([{ component: root, basis: 1 }]);

		const frame = renderLayoutFrame(root, 10, 1, () => {});
		expect(visibleLines(frame.lines)).toStrictEqual(["x"]);
	});

	it("skips pathologically deep component nesting instead of overflowing the stack", () => {
		// 2_000 exceeds the layout depth cap (512) and used to overflow the JS stack
		// before the cap existed; the deep subtree is skipped, the frame stays valid.
		const depth = 2_000;
		let root: VStack = new VStack([{ component: new Text("x", 0, 0), basis: 1 }]);
		for (let i = 1; i < depth; i++) root = new VStack([{ component: root, basis: 1 }]);

		const frame = renderLayoutFrame(root, 10, 1, () => {});
		expect(frame.root).toBeTruthy();
		expect(frame.lines.length).toStrictEqual(1);
		expect(visibleLines(frame.lines)).toStrictEqual([""]);
	});

	it("re-reads a function maxSize on every layout pass", () => {
		const body = { render: () => Array.from({ length: 10 }, (_, i) => `row ${i}`), invalidate: () => {} };
		let cap = 3;
		const stack = new VStack([
			{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
			{ component: body, basis: 0, grow: 1, maxSize: () => cap },
		]);

		const first = renderLayoutFrame(stack, 10, 10, () => {});
		expect(first.root.children.map((child) => child.rect.height)).toStrictEqual([1, 3]);

		cap = 6;
		const second = renderLayoutFrame(stack, 10, 10, () => {});
		// The ceiling is read again, so the body grows past the value the first
		// pass captured instead of staying clamped at 3.
		expect(second.root.children.map((child) => child.rect.height)).toStrictEqual([1, 6]);
	});
});
