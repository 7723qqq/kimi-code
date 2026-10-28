import { expect, describe, it } from "bun:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { extractSegments, normalizeTerminalOutput, sliceWithWidth, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FullViewportContent implements Component {
	render(width: number): string[] {
		return ["base 0", "base 1", "base 2"].map((line) => line.padEnd(width));
	}

	invalidate(): void {}
}

class CapturingVirtualTerminal extends VirtualTerminal {
	private output = "";

	override write(data: string): void {
		this.output += data;
		super.write(data);
	}

	getOutput(): string {
		return this.output;
	}
}

class TabStatusOverlay implements Component {
	render(): string[] {
		return ["\tX"];
	}

	invalidate(): void {}
}

describe("tab width accounting", () => {
	it("keeps slice helper widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const slice = sliceWithWidth(text, 0, 10, true);

		expect(slice.text).toBe("out 192M");
		expect(slice.width).toBe(8);
		expect(visibleWidth(slice.text)).toBe(slice.width);
	});

	it("keeps overlay segment widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const segments = extractSegments(text, 10, 13, 10, true);

		expect(segments.before).toBe("out 192M");
		expect(segments.beforeWidth).toBe(8);
		expect(visibleWidth(segments.before)).toBe(segments.beforeWidth);

		const tabFits = extractSegments(text, 11, 13, 10, true);
		expect(tabFits.before).toBe("out 192M\t");
		expect(tabFits.beforeWidth).toBe(11);
		expect(visibleWidth(tabFits.before)).toBe(tabFits.beforeWidth);
	});

	it("keeps tabs inside terminal control sequences byte-identical", () => {
		const controlSequences = [
			"\x1b]8;;https://example.test/a\tb\x07",
			"\x1b]0;window\ttitle\x1b\\",
			"\x1b_payload\tdata\x1b\\",
		];

		for (const controlSequence of controlSequences) {
			expect(normalizeTerminalOutput(`${controlSequence}label\ttext`)).toBe(`${controlSequence}label   text`);
		}
	});

	it("keeps tab-containing overlays on one physical terminal row", async () => {
		const terminal = new CapturingVirtualTerminal(16, 3);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new FullViewportContent());
		tui.showOverlay(new TabStatusOverlay(), { width: 4, row: 1, col: 4 });
		tui.start();

		try {
			await terminal.waitForRender();
			expect(terminal.getViewport()).toStrictEqual(["base 0          ", "base   X        ", "base 2          "]);
			expect(!terminal.getOutput().includes("\t")).toBeTruthy();
		} finally {
			tui.stop();
		}
	});
});
