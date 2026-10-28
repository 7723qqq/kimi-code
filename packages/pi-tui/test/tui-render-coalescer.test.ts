import { expect, describe, it } from "bun:test";
import type { Terminal } from "../src/terminal.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

/**
 * The coalescer re-arms after any frame that left a render request pending. A request raised
 * *during* a frame is raised by that frame (a component writing state, a cache invalidation, a
 * width setter — the layout pass hands the frame's requestRender callback to components), so an
 * unconditional re-arm turns one frame into a permanent 62.5 Hz chain on a static screen. These
 * tests pin the clean-frame guard that bounds it, and that the bound never wedges the TUI.
 */

/** Discards output; keeps xterm parsing and real terminal I/O out of the measurement. */
class DiscardingTerminal implements Terminal {
	static readonly COLUMNS = 80;
	static readonly ROWS = 24;
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.inputHandler = onInput;
	}
	stop(): void {
		this.inputHandler = undefined;
	}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	get columns(): number {
		return DiscardingTerminal.COLUMNS;
	}
	get rows(): number {
		return DiscardingTerminal.ROWS;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}
}

class CountingTuiAltScreen extends TuiAltScreen {
	frames = 0;

	protected override doRender(): void {
		this.frames += 1;
		super.doRender();
	}
}

/** Asks for another frame from inside its own render pass, like the layout requestRender callback. */
class SelfRequestingComponent implements Component {
	renders = 0;
	text = "static content";
	force = false;
	requesting = true;
	private readonly requestRender: (force?: boolean) => void;
	private readonly animate: boolean;

	constructor(requestRender: (force?: boolean) => void, animate: boolean) {
		this.requestRender = requestRender;
		this.animate = animate;
	}

	render(): string[] {
		this.renders += 1;
		if (this.requesting) this.requestRender(this.force);
		if (this.animate) this.text = `animated ${this.renders}`;
		return [this.text];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.text = `typed ${data}`;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("render coalescer clean-frame guard", () => {
	it("keeps re-arming while frames produce output", async () => {
		const terminal = new DiscardingTerminal();
		const tui = new CountingTuiAltScreen(terminal);
		const component = new SelfRequestingComponent(() => tui.requestRender(), true);
		tui.setLayoutRoot(component);
		tui.start();
		try {
			tui.renderNow();
			await delay(200);
			// Every frame changed a row, so every request it raised deserves another frame.
			expect(tui.frames >= 4, `a frame that produced output must keep the chain alive, saw ${tui.frames} frames`).toBeTruthy();
		} finally {
			tui.stop();
		}
	});

	it("stops re-arming after a frame that produced no output", async () => {
		const terminal = new DiscardingTerminal();
		const tui = new CountingTuiAltScreen(terminal);
		const component = new SelfRequestingComponent(() => tui.requestRender(), false);
		tui.setLayoutRoot(component);
		tui.start();
		try {
			tui.renderNow();
			await delay(200);
			// Frame 1 wrote the line. The two frames the guard allows after it emit nothing, then
			// the chain must end: without the guard this window holds ~13 frames and keeps going.
			expect(tui.frames <= 3, `a clean frame must not hold a render chain, saw ${tui.frames} frames`).toBeTruthy();
			const framesAfterChain = tui.frames;
			await delay(200);
			expect(tui.frames, "the chain must stop, not merely slow down").toBe(framesAfterChain);
		} finally {
			tui.stop();
		}
	});

	it("still renders immediately when input arrives after the guard dropped a request", async () => {
		const terminal = new DiscardingTerminal();
		const tui = new CountingTuiAltScreen(terminal);
		const component = new SelfRequestingComponent(() => tui.requestRender(), false);
		tui.setLayoutRoot(component);
		tui.setFocus(component);
		tui.start();
		try {
			tui.renderNow();
			// Let the guard drop the frame's own pending request, which clears renderRequested.
			await delay(100);
			const framesBeforeInput = tui.frames;
			terminal.sendInput("hello");
			await new Promise<void>((resolve) => process.nextTick(resolve));
			expect(tui.frames, "input must render on its own frame after the guard dropped a request").toBe(framesBeforeInput + 1);
			expect(component.text).toBe("typed hello");
		} finally {
			tui.stop();
		}
	});

	it("bounds a forced render that keeps re-requesting itself", async () => {
		const terminal = new DiscardingTerminal();
		const tui = new CountingTuiAltScreen(terminal);
		const component = new SelfRequestingComponent(() => tui.requestRender(true), false);
		tui.setLayoutRoot(component);
		tui.start();
		try {
			tui.renderNow();
			await delay(200);
			// A forced frame clears the previous-screen cache before it runs, so it repaints every
			// row and reports output whatever the content is: the clean-frame test cannot end this
			// chain. The forced cap answers the frame's own request once, then drops it.
			expect(tui.frames >= 2 && tui.frames <= 3, `a forced self-request must not hold a render chain, saw ${tui.frames} frames`).toBeTruthy();
			const framesAfterChain = tui.frames;
			await delay(200);
			expect(tui.frames, "the forced chain must stop, not merely slow down").toBe(framesAfterChain);
		} finally {
			tui.stop();
		}
	});

	it("delivers a host forced render immediately after the forced cap dropped a request", async () => {
		const terminal = new DiscardingTerminal();
		const tui = new CountingTuiAltScreen(terminal);
		const component = new SelfRequestingComponent(() => tui.requestRender(true), false);
		tui.setLayoutRoot(component);
		tui.start();
		try {
			tui.renderNow();
			// Let the forced cap drop the frame's own request, which clears renderRequested.
			await delay(200);
			component.requesting = false;
			const framesBeforeForce = tui.frames;
			tui.requestRender(true);
			await new Promise<void>((resolve) => process.nextTick(resolve));
			expect(tui.frames, "a forced render must not wait for the throttled timer path").toBe(framesBeforeForce + 1);
		} finally {
			tui.stop();
		}
	});
});
