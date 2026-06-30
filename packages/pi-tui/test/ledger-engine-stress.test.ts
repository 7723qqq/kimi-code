import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prev = process.env["PI_TUI_ENGINE"];
	process.env["PI_TUI_ENGINE"] = "ledger";
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prev;
	}
}

describe("ledger engine stress (seeded)", () => {
	for (const seed of [1, 2, 3, 7, 42, 99]) {
		it(`seed=${seed}: viewport consistent, scrollback append-only`, async () => {
			await withLedger(async () => {
				const rand = mulberry32(seed);
				const terminal = new VirtualTerminal(40, 8);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = ["init"];
				tui.start();
				await terminal.waitForRender();

				let prevScrollbackLen = terminal.getScrollBuffer().length;
				for (let step = 0; step < 60; step++) {
					const op = rand();
					const len = c.lines.length;
					let resized = false;
					if (op < 0.5) {
						// append
						c.lines = [...c.lines, `s${step}-a`];
					} else if (op < 0.75 && len > 1) {
						// mutate a live tail row
						const copy = c.lines.slice();
						copy[copy.length - 1] = `s${step}-m`;
						c.lines = copy;
					} else if (op < 0.9 && len > 1) {
						// shrink
						c.lines = c.lines.slice(0, Math.max(1, len - 1 - Math.floor(rand() * 3)));
					} else {
						// resize
						terminal.resize(30 + Math.floor(rand() * 40), 6 + Math.floor(rand() * 6));
						resized = true;
					}
					tui.requestRender();
					await terminal.waitForRender();

					// invariant (non-resize steps only): scrollback length never decreases.
					// Resize steps are exempt: xterm.js trims trailing blank rows on resize-to-smaller,
					// and Phase A intentionally fullPaints with clearScrollback on non-mux geometry rebuild.
					const sb = terminal.getScrollBuffer();
					if (!resized) {
						assert.ok(sb.length >= prevScrollbackLen, `seed=${seed} step=${step}: scrollback shrank`);
					}
					prevScrollbackLen = sb.length;

					// invariant (all steps): viewport tail reflects the latest content
					const viewport = terminal.getViewport();
					const lastLine = c.lines[c.lines.length - 1]!;
					assert.ok(
						viewport.join("\n").includes(lastLine.slice(0, Math.min(10, lastLine.length))),
						`seed=${seed} step=${step}: tail not visible`,
					);
				}
				tui.stop();
			});
		});
	}
});
