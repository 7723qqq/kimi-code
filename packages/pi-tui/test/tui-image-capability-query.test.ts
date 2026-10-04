/**
 * Tests for the startup image-capability query (Kitty graphics + DA1).
 *
 * The TUI sends the queries only when static detection found no protocol
 * and the session is not inside a multiplexer; replies are consumed by
 * `consumeImageCapabilityResponse` and upgrade the cached capabilities.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { getCapabilities, resetCapabilitiesCache } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ENV_KEYS = [
	"TERM_PROGRAM",
	"TERM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"MLTERM",
	"TERMUX_VERSION",
] as const;

function withNoImageTerminal<T>(fn: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	resetCapabilitiesCache();
	try {
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		resetCapabilitiesCache();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI image capability query", () => {
	it("upgrades capabilities to kitty from the graphics query reply", () => {
		withNoImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();
			assert.strictEqual(getCapabilities().images, null);

			terminal.sendInput("\x1b_Gi=1;OK\x1b\\");
			assert.strictEqual(getCapabilities().images, "kitty");
			assert.deepStrictEqual(recorder.inputs, [], "the reply must be consumed, not forwarded");

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"], "later user input still forwards");
			tui.stop();
		});
	});

	it("upgrades capabilities to sixel from the DA1 reply", () => {
		withNoImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[?1;2;62c");
			assert.strictEqual(getCapabilities().images, "sixel");
			assert.deepStrictEqual(recorder.inputs, []);
			tui.stop();
		});
	});

	it("consumes an explicit unsupported reply without changing capabilities", () => {
		withNoImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b_Gi=1;ENOENT\x1b\\");
			assert.strictEqual(getCapabilities().images, null);
			assert.deepStrictEqual(recorder.inputs, [], "the unsupported reply must be consumed too");
			tui.stop();
		});
	});

	it("does not consume unrelated input while the query is pending", () => {
		withNoImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("hello");
			assert.deepStrictEqual(recorder.inputs, ["hello"]);
			tui.stop();
		});
	});

	it("does not consume capability replies inside tmux (no query was sent)", () => {
		withNoImageTerminal(() => {
			process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
			resetCapabilitiesCache();
			try {
				const terminal = new VirtualTerminal(80, 24);
				const tui: TUI = new TuiMainScreen(terminal);
				const recorder = new InputRecorder();

				tui.setFocus(recorder);
				tui.start();

				terminal.sendInput("\x1b_Gi=1;OK\x1b\\");
				assert.strictEqual(getCapabilities().images, null);
				assert.deepStrictEqual(recorder.inputs, ["\x1b_Gi=1;OK\x1b\\"], "unqueried replies pass through");
				tui.stop();
			} finally {
				delete process.env.TMUX;
				resetCapabilitiesCache();
			}
		});
	});
});
