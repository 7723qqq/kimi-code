/**
 * Tests for the startup image-capability query (Kitty graphics + DA1).
 *
 * The TUI sends the queries only when static detection found no protocol
 * and the session is not inside a multiplexer; replies are consumed by
 * `consumeImageCapabilityResponse` and upgrade the cached capabilities.
 */

import { expect, describe, it } from "bun:test";
import {
  getCapabilities,
  imagesProtocolIsGuessed,
  resetCapabilitiesCache,
} from "../src/terminal-image.ts";
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
	"PI_IMAGE_PROTOCOL",
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

function withWindowsTerminal<T>(fn: () => T): T {
  return withNoImageTerminal(() => {
    process.env.WT_SESSION = "a1b2c3d4-0000-0000-0000-000000000000";
    resetCapabilitiesCache();
    return fn();
  });
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
			expect(getCapabilities().images).toBe(null);

			terminal.sendInput("\x1b_Gi=1;OK\x1b\\");
			expect(getCapabilities().images).toBe("kitty");
			expect(recorder.inputs, "the reply must be consumed, not forwarded").toStrictEqual([]);

			terminal.sendInput("q");
			expect(recorder.inputs, "later user input still forwards").toStrictEqual(["q"]);
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
			expect(getCapabilities().images).toBe("sixel");
			expect(recorder.inputs).toStrictEqual([]);
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
			expect(getCapabilities().images).toBe(null);
			expect(recorder.inputs, "the unsupported reply must be consumed too").toStrictEqual([]);
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
			expect(recorder.inputs).toStrictEqual(["hello"]);
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
				expect(getCapabilities().images).toBe(null);
				expect(recorder.inputs, "unqueried replies pass through").toStrictEqual(["\x1b_Gi=1;OK\x1b\\"]);
				tui.stop();
			} finally {
				delete process.env.TMUX;
				resetCapabilitiesCache();
			}
		});
	});

	it("marks the Windows Terminal sixel claim as a guess", () => {
		withWindowsTerminal(() => {
			expect(getCapabilities().images).toBe("sixel");
			expect(imagesProtocolIsGuessed()).toBe(true);
		});
	});

	it("does not treat an explicit protocol override as a Windows Terminal guess", () => {
		withWindowsTerminal(() => {
			process.env.PI_IMAGE_PROTOCOL = "kitty";
			resetCapabilitiesCache();

			expect(getCapabilities().images).toBe("kitty");
			expect(imagesProtocolIsGuessed()).toBe(false);
		});
	});

	it("asks the terminal when sixel is only a guess, and keeps it on an explicit no", () => {
		withWindowsTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			// ConPTY answers the startup DA1 query on the terminal's behalf with
			// a bare `?61c` that carries no feature information. The reply is
			// consumed rather than forwarded, but it must not retract the
			// Windows Terminal sixel claim — retracting on it turned a working
			// sixel terminal back into a text placeholder.
			terminal.sendInput("\x1b[?61c");
			expect(getCapabilities().images).toBe("sixel");
			expect(imagesProtocolIsGuessed()).toBe(true);
			expect(recorder.inputs).toStrictEqual([]);
			tui.stop();
		});
	});

	it("keeps sixel when the Windows Terminal reply confirms it", () => {
		withWindowsTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[?1;2;62c");
			expect(getCapabilities().images).toBe("sixel");
			tui.stop();
		});
	});

	it("accepts the DEC DA1 sixel parameter (4) as confirmation", () => {
		withWindowsTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[?64;1;2;4c");
			expect(getCapabilities().images).toBe("sixel");
			tui.stop();
		});
	});
});
