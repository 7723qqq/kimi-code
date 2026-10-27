import { expect, describe, it } from "bun:test";
import {
	type Component,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TUI,
	TuiMainScreen,
} from "../src/index.ts";

class TestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
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

	sendResize(): void {
		this.resizeHandler?.();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("parseOsc11BackgroundColor", () => {
	it("parses 16-bit OSC 11 rgb responses", () => {
		expect(parseOsc11BackgroundColor("\x1b]11;rgb:0000/8000/ffff\x07")).toStrictEqual({
			r: 0,
			g: 128,
			b: 255,
		});
	});

	it("parses OSC 11 hex responses", () => {
		expect(parseOsc11BackgroundColor("\x1b]11;#ffffff\x1b\\")).toStrictEqual({ r: 255, g: 255, b: 255 });
		expect(parseOsc11BackgroundColor("\x1b]11;#000000\x07")).toStrictEqual({ r: 0, g: 0, b: 0 });
	});

	it("rejects non-strict OSC 11 responses", () => {
		expect(parseOsc11BackgroundColor(`x\x1b]11;#ffffff\x07`)).toBe(undefined);
		expect(parseOsc11BackgroundColor("\x1b]10;#ffffff\x07")).toBe(undefined);
		expect(parseOsc11BackgroundColor("\x1b]11;#ffffff\x07x")).toBe(undefined);
	});
});

describe("parseTerminalColorSchemeReport", () => {
	it("parses color scheme reports", () => {
		expect(parseTerminalColorSchemeReport("\x1b[?997;1n")).toBe("dark");
		expect(parseTerminalColorSchemeReport("\x1b[?997;2n")).toBe("light");
		expect(parseTerminalColorSchemeReport("\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n")).toBe("dark");
		expect(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n")).toBe("light");
		expect(parseTerminalColorSchemeReport("\x1b[?997;3n")).toBe(undefined);
		expect(parseTerminalColorSchemeReport("\x1b[?996n")).toBe(undefined);
		expect(parseTerminalColorSchemeReport("x\x1b[?997;1n")).toBe(undefined);
	});
});

describe("TUI.queryTerminalBackgroundColor", () => {
	it("writes OSC 11 query and resolves with the parsed RGB reply", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			expect(terminal.writes.includes("\x1b]11;?\x07")).toBeTruthy();

			terminal.sendInput("\x1b]11;#ffffff\x07");

			expect(await query).toStrictEqual({ r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("consumes OSC 11 replies before input listeners and focused component dispatch", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;#000000\x07");

			expect(await query).toStrictEqual({ r: 0, g: 0, b: 0 });
			expect(listenerInputs).toStrictEqual([]);
			expect(component.inputs).toStrictEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("consumes unparseable strict OSC 11 replies and resolves undefined", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;not-a-color\x07");

			expect(await query).toBe(undefined);
			expect(listenerInputs).toStrictEqual([]);
			expect(component.inputs).toStrictEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("dispatches non-matching input normally while waiting for an OSC 11 reply", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			let settled = false;
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 }).then((rgb) => {
				settled = true;
				return rgb;
			});

			terminal.sendInput("x");
			await Promise.resolve();

			expect(settled).toBe(false);
			expect(listenerInputs).toStrictEqual(["x"]);
			expect(component.inputs).toStrictEqual(["x"]);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			expect(await query).toStrictEqual({ r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("keeps consuming a late OSC 11 reply after timeout", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1 });
			await wait(5);

			expect(await query).toBe(undefined);

			terminal.sendInput("\x1b]11;#ffffff\x07");

			expect(listenerInputs).toStrictEqual([]);
			expect(component.inputs).toStrictEqual([]);
		} finally {
			tui.stop();
		}
	});
});
