/**
 * Tests for keyboard input handling
 */

import { expect, describe, it } from "bun:test";
import {
	decodeKittyPrintable,
	decodePrintableKey,
	Key,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "../src/keys.ts";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

function withEnvVars(vars: Record<string, string | undefined>, fn: () => void): void {
	const entries = Object.entries(vars);
	const run = (index: number): void => {
		if (index >= entries.length) {
			fn();
			return;
		}
		const [name, value] = entries[index]!;
		withEnv(name, value, () => run(index + 1));
	};
	run(0);
}

describe("matchesKey", () => {
	describe("Kitty protocol with alternate keys (non-Latin layouts)", () => {
		// Kitty protocol flag 4 (Report alternate keys) sends:
		// CSI codepoint:shifted:base ; modifier:event u
		// Where base is the key in standard PC-101 layout

		it("should match Ctrl+c when pressing Ctrl+С (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'с' = codepoint 1089, Latin 'c' = codepoint 99
			// Format: CSI 1089::99;5u (codepoint::base;modifier with ctrl=4, +1=5)
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			expect(matchesKey(cyrillicCtrlC, "ctrl+c")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+d when pressing Ctrl+В (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'в' = codepoint 1074, Latin 'd' = codepoint 100
			const cyrillicCtrlD = "\x1b[1074::100;5u";
			expect(matchesKey(cyrillicCtrlD, "ctrl+d")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+z when pressing Ctrl+Я (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'я' = codepoint 1103, Latin 'z' = codepoint 122
			const cyrillicCtrlZ = "\x1b[1103::122;5u";
			expect(matchesKey(cyrillicCtrlZ, "ctrl+z")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+Shift+p with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'з' = codepoint 1079, Latin 'p' = codepoint 112
			// ctrl=4, shift=1, +1 = 6
			const cyrillicCtrlShiftP = "\x1b[1079::112;6u";
			expect(matchesKey(cyrillicCtrlShiftP, "ctrl+shift+p")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should still match direct codepoint when no base layout key", () => {
			setKittyProtocolActive(true);
			// Latin ctrl+c without base layout key (terminal doesn't support flag 4)
			const latinCtrlC = "\x1b[99;5u";
			expect(matchesKey(latinCtrlC, "ctrl+c")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should match super-modified Kitty bindings, including combined modifiers", () => {
			setKittyProtocolActive(true);
			expect(matchesKey("\x1b[107;9u", "super+k")).toBe(true);
			expect(matchesKey("\x1b[13;9u", "super+enter")).toBe(true);
			expect(matchesKey("\x1b[107;13u", Key.ctrlSuper("k"))).toBe(true);
			expect(matchesKey("\x1b[107;13u", "ctrl+super+k")).toBe(true);
			expect(matchesKey("\x1b[107;14u", "ctrl+shift+super+k")).toBe(true);
			expect(matchesKey("\x1b[107;13u", "super+k")).toBe(false);
			expect(parseKey("\x1b[107;9u")).toBe("super+k");
			expect(parseKey("\x1b[13;9u")).toBe("super+enter");
			expect(parseKey("\x1b[107;13u")).toBe("ctrl+super+k");
			expect(parseKey("\x1b[107;14u")).toBe("shift+ctrl+super+k");
			setKittyProtocolActive(false);
		});

		it("should match digit bindings via Kitty CSI-u", () => {
			setKittyProtocolActive(true);
			expect(matchesKey("\x1b[49u", "1")).toBe(true);
			expect(matchesKey("\x1b[49;5u", "ctrl+1")).toBe(true);
			expect(matchesKey("\x1b[49;5u", "ctrl+2")).toBe(false);
			expect(parseKey("\x1b[49u")).toBe("1");
			expect(parseKey("\x1b[49;5u")).toBe("ctrl+1");
			setKittyProtocolActive(false);
		});

		it("should normalize Kitty keypad functional keys to logical digits, symbols, and navigation", () => {
			setKittyProtocolActive(true);
			expect(matchesKey("\x1b[57400u", "1")).toBe(true);
			expect(matchesKey("\x1b[57410u", "/")).toBe(true);
			expect(matchesKey("\x1b[57417u", "left")).toBe(true);
			expect(matchesKey("\x1b[57426u", "delete")).toBe(true);
			expect(parseKey("\x1b[57399u")).toBe("0");
			expect(parseKey("\x1b[57409u")).toBe(".");
			expect(parseKey("\x1b[57413u")).toBe("+");
			expect(parseKey("\x1b[57416u")).toBe(",");
			expect(parseKey("\x1b[57417u")).toBe("left");
			expect(parseKey("\x1b[57418u")).toBe("right");
			expect(parseKey("\x1b[57419u")).toBe("up");
			expect(parseKey("\x1b[57420u")).toBe("down");
			expect(parseKey("\x1b[57421u")).toBe("pageUp");
			expect(parseKey("\x1b[57422u")).toBe("pageDown");
			expect(parseKey("\x1b[57423u")).toBe("home");
			expect(parseKey("\x1b[57424u")).toBe("end");
			expect(parseKey("\x1b[57425u")).toBe("insert");
			expect(parseKey("\x1b[57426u")).toBe("delete");
			setKittyProtocolActive(false);
		});

		it("should handle shifted key in format", () => {
			setKittyProtocolActive(true);
			// Format with shifted key: CSI codepoint:shifted:base;modifier u
			// Latin 'c' with shifted 'C' (67) and base 'c' (99)
			const shiftedKey = "\x1b[99:67:99;2u"; // shift modifier = 1, +1 = 2
			expect(matchesKey(shiftedKey, "shift+c")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should handle event type in format", () => {
			setKittyProtocolActive(true);
			// Format with event type: CSI codepoint::base;modifier:event u
			// Cyrillic ctrl+c release event (event type 3)
			const releaseEvent = "\x1b[1089::99;5:3u";
			expect(matchesKey(releaseEvent, "ctrl+c")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should handle full format with shifted key, base key, and event type", () => {
			setKittyProtocolActive(true);
			// Full format: CSI codepoint:shifted:base;modifier:event u
			// Cyrillic 'С' (shifted) with base 'c', Ctrl+Shift pressed, repeat event
			// Cyrillic 'с' = 1089, Cyrillic 'С' = 1057, Latin 'c' = 99
			// ctrl=4, shift=1, +1 = 6, repeat event = 2
			const fullFormat = "\x1b[1089:1057:99;6:2u";
			expect(matchesKey(fullFormat, "ctrl+shift+c")).toBe(true);
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for Latin letters even when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			const dvorakCtrlK = "\x1b[107::118;5u";
			expect(matchesKey(dvorakCtrlK, "ctrl+k")).toBe(true);
			expect(matchesKey(dvorakCtrlK, "ctrl+v")).toBe(false);
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for symbol keys even when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			expect(matchesKey(dvorakCtrlSlash, "ctrl+/")).toBe(true);
			expect(matchesKey(dvorakCtrlSlash, "ctrl+[")).toBe(false);
			setKittyProtocolActive(false);
		});

		it("should not match wrong key even with base layout", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base 'c' should NOT match ctrl+d
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			expect(matchesKey(cyrillicCtrlC, "ctrl+d")).toBe(false);
			setKittyProtocolActive(false);
		});

		it("should not match wrong modifiers even with base layout", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с should NOT match ctrl+shift+c
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			expect(matchesKey(cyrillicCtrlC, "ctrl+shift+c")).toBe(false);
			setKittyProtocolActive(false);
		});
	});

	describe("modifyOtherKeys matching", () => {
		it("should match xterm modifyOtherKeys Ctrl+c", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;99~", "ctrl+c")).toBe(true);
			expect(parseKey("\x1b[27;5;99~")).toBe("ctrl+c");
		});

		it("should match xterm modifyOtherKeys Ctrl+d", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;100~", "ctrl+d")).toBe(true);
			expect(parseKey("\x1b[27;5;100~")).toBe("ctrl+d");
		});

		it("should match xterm modifyOtherKeys Ctrl+z", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;122~", "ctrl+z")).toBe(true);
			expect(parseKey("\x1b[27;5;122~")).toBe("ctrl+z");
		});

		it("should match xterm modifyOtherKeys Enter variants", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;13~", "ctrl+enter")).toBe(true);
			expect(matchesKey("\x1b[27;2;13~", "shift+enter")).toBe(true);
			expect(matchesKey("\x1b[27;3;13~", "alt+enter")).toBe(true);
			expect(parseKey("\x1b[27;5;13~")).toBe("ctrl+enter");
			expect(parseKey("\x1b[27;2;13~")).toBe("shift+enter");
			expect(parseKey("\x1b[27;3;13~")).toBe("alt+enter");
		});

		it("should match xterm modifyOtherKeys Tab variants", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;2;9~", "shift+tab")).toBe(true);
			expect(matchesKey("\x1b[27;5;9~", "ctrl+tab")).toBe(true);
			expect(matchesKey("\x1b[27;3;9~", "alt+tab")).toBe(true);
			expect(parseKey("\x1b[27;2;9~")).toBe("shift+tab");
			expect(parseKey("\x1b[27;5;9~")).toBe("ctrl+tab");
			expect(parseKey("\x1b[27;3;9~")).toBe("alt+tab");
		});

		it("should match xterm modifyOtherKeys Backspace variants", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;1;127~", "backspace")).toBe(true);
			expect(matchesKey("\x1b[27;5;127~", "ctrl+backspace")).toBe(true);
			expect(matchesKey("\x1b[27;3;127~", "alt+backspace")).toBe(true);
			expect(parseKey("\x1b[27;1;127~")).toBe("backspace");
			expect(parseKey("\x1b[27;5;127~")).toBe("ctrl+backspace");
			expect(parseKey("\x1b[27;3;127~")).toBe("alt+backspace");
		});

		it("should match xterm modifyOtherKeys Escape", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;1;27~", "escape")).toBe(true);
			expect(parseKey("\x1b[27;1;27~")).toBe("escape");
		});

		it("should match xterm modifyOtherKeys Space variants", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;1;32~", "space")).toBe(true);
			expect(matchesKey("\x1b[27;5;32~", "ctrl+space")).toBe(true);
			expect(parseKey("\x1b[27;1;32~")).toBe("space");
			expect(parseKey("\x1b[27;5;32~")).toBe("ctrl+space");
		});

		it("should match xterm modifyOtherKeys symbol combos", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;47~", "ctrl+/")).toBe(true);
			expect(parseKey("\x1b[27;5;47~")).toBe("ctrl+/");
		});

		it("should match xterm modifyOtherKeys digit combos", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;5;49~", "ctrl+1")).toBe(true);
			expect(matchesKey("\x1b[27;2;49~", "shift+1")).toBe(true);
			expect(parseKey("\x1b[27;5;49~")).toBe("ctrl+1");
			expect(parseKey("\x1b[27;2;49~")).toBe("shift+1");
		});

		it("should match xterm modifyOtherKeys shifted uppercase letters", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;2;69~", "shift+e")).toBe(true);
			expect(matchesKey("\x1b[27;6;69~", "ctrl+shift+e")).toBe(true);
			expect(parseKey("\x1b[27;2;69~")).toBe("shift+e");
			expect(parseKey("\x1b[27;6;69~")).toBe("shift+ctrl+e");
		});

		it("should match Ctrl+Alt+letter via CSI-u when kitty inactive", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[104;7u", "ctrl+alt+h")).toBe(true);
			expect(parseKey("\x1b[104;7u")).toBe("ctrl+alt+h");
		});

		it("should match Ctrl+Alt+letter via xterm modifyOtherKeys", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b[27;7;104~", "ctrl+alt+h")).toBe(true);
			expect(parseKey("\x1b[27;7;104~")).toBe("ctrl+alt+h");
		});
	});

	describe("Legacy key matching", () => {
		it("should match legacy Ctrl+c", () => {
			setKittyProtocolActive(false);
			// Ctrl+c sends ASCII 3 (ETX)
			expect(matchesKey("\x03", "ctrl+c")).toBe(true);
		});

		it("should match legacy Ctrl+d", () => {
			setKittyProtocolActive(false);
			// Ctrl+d sends ASCII 4 (EOT)
			expect(matchesKey("\x04", "ctrl+d")).toBe(true);
		});

		it("should match escape key", () => {
			expect(matchesKey("\x1b", "escape")).toBe(true);
		});

		it("should match legacy linefeed as enter", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\n", "enter")).toBe(true);
			expect(parseKey("\n")).toBe("enter");
		});

		it("should treat linefeed as shift+enter when kitty active", () => {
			setKittyProtocolActive(true);
			expect(matchesKey("\n", "shift+enter")).toBe(true);
			expect(matchesKey("\n", "enter")).toBe(false);
			expect(parseKey("\n")).toBe("shift+enter");
			setKittyProtocolActive(false);
		});

		it("should parse ctrl+space", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x00", "ctrl+space")).toBe(true);
			expect(parseKey("\x00")).toBe("ctrl+space");
		});

		it("should match legacy Ctrl+symbol", () => {
			setKittyProtocolActive(false);
			// Ctrl+\ sends ASCII 28 (File Separator) in legacy terminals
			expect(matchesKey("\x1c", "ctrl+\\")).toBe(true);
			expect(parseKey("\x1c")).toBe("ctrl+\\");
			// Ctrl+] sends ASCII 29 (Group Separator) in legacy terminals
			expect(matchesKey("\x1d", "ctrl+]")).toBe(true);
			expect(parseKey("\x1d")).toBe("ctrl+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			expect(matchesKey("\x1f", "ctrl+_")).toBe(true);
			expect(matchesKey("\x1f", "ctrl+-")).toBe(true);
			expect(parseKey("\x1f")).toBe("ctrl+-");
		});

		it("should match legacy Ctrl+Alt+symbol", () => {
			setKittyProtocolActive(false);
			// Ctrl+Alt+[ sends ESC followed by ESC (Ctrl+[ = ESC)
			expect(matchesKey("\x1b\x1b", "ctrl+alt+[")).toBe(true);
			expect(parseKey("\x1b\x1b")).toBe("ctrl+alt+[");
			// Ctrl+Alt+\ sends ESC followed by ASCII 28
			expect(matchesKey("\x1b\x1c", "ctrl+alt+\\")).toBe(true);
			expect(parseKey("\x1b\x1c")).toBe("ctrl+alt+\\");
			// Ctrl+Alt+] sends ESC followed by ASCII 29
			expect(matchesKey("\x1b\x1d", "ctrl+alt+]")).toBe(true);
			expect(parseKey("\x1b\x1d")).toBe("ctrl+alt+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			expect(matchesKey("\x1b\x1f", "ctrl+alt+_")).toBe(true);
			expect(matchesKey("\x1b\x1f", "ctrl+alt+-")).toBe(true);
			expect(parseKey("\x1b\x1f")).toBe("ctrl+alt+-");
		});

		it("should treat raw 0x08 as plain backspace outside Windows Terminal", () => {
			setKittyProtocolActive(false);
			withEnv("WT_SESSION", undefined, () => {
				expect(matchesKey("\x7f", "backspace")).toBe(true);
				expect(matchesKey("\x7f", "ctrl+backspace")).toBe(false);
				expect(parseKey("\x7f")).toBe("backspace");
				expect(matchesKey("\x08", "backspace")).toBe(true);
				expect(matchesKey("\x08", "ctrl+backspace")).toBe(false);
				expect(parseKey("\x08")).toBe("backspace");
				expect(matchesKey("\x08", "ctrl+h")).toBe(true);
			});
		});

		it("should treat raw 0x08 as ctrl+backspace in local Windows Terminal", () => {
			setKittyProtocolActive(false);
			withEnvVars(
				{
					WT_SESSION: "test-session",
					SSH_CONNECTION: undefined,
					SSH_CLIENT: undefined,
					SSH_TTY: undefined,
				},
				() => {
					expect(matchesKey("\x08", "ctrl+backspace")).toBe(true);
					expect(matchesKey("\x08", "backspace")).toBe(false);
					expect(parseKey("\x08")).toBe("ctrl+backspace");
					expect(matchesKey("\x08", "ctrl+h")).toBe(true);
				},
			);
		});

		it("should treat raw 0x08 as plain backspace in Windows Terminal over SSH", () => {
			setKittyProtocolActive(false);
			withEnvVars(
				{
					WT_SESSION: "test-session",
					SSH_CONNECTION: "1 2 3 4",
					SSH_CLIENT: "1 2 3",
					SSH_TTY: "/dev/pts/1",
				},
				() => {
					expect(matchesKey("\x08", "ctrl+backspace")).toBe(false);
					expect(matchesKey("\x08", "backspace")).toBe(true);
					expect(parseKey("\x08")).toBe("backspace");
					expect(matchesKey("\x08", "ctrl+h")).toBe(true);
				},
			);
		});

		it("should parse legacy alt-prefixed sequences when kitty inactive", () => {
			setKittyProtocolActive(false);
			expect(matchesKey("\x1b ", "alt+space")).toBe(true);
			expect(parseKey("\x1b ")).toBe("alt+space");
			expect(matchesKey("\x1b\b", "alt+backspace")).toBe(true);
			expect(parseKey("\x1b\b")).toBe("alt+backspace");
			expect(matchesKey("\x1b\x03", "ctrl+alt+c")).toBe(true);
			expect(parseKey("\x1b\x03")).toBe("ctrl+alt+c");
			expect(matchesKey("\x1bB", "alt+left")).toBe(true);
			expect(parseKey("\x1bB")).toBe("alt+left");
			expect(matchesKey("\x1bF", "alt+right")).toBe(true);
			expect(parseKey("\x1bF")).toBe("alt+right");
			expect(matchesKey("\x1ba", "alt+a")).toBe(true);
			expect(parseKey("\x1ba")).toBe("alt+a");
			expect(matchesKey("\x1b1", "alt+1")).toBe(true);
			expect(parseKey("\x1b1")).toBe("alt+1");
			expect(matchesKey("\x1b,", "alt+,")).toBe(true);
			expect(parseKey("\x1b,")).toBe("alt+,");
			expect(matchesKey("\x1b.", "alt+.")).toBe(true);
			expect(parseKey("\x1b.")).toBe("alt+.");
			expect(matchesKey("\x1by", "alt+y")).toBe(true);
			expect(parseKey("\x1by")).toBe("alt+y");
			expect(matchesKey("\x1bz", "alt+z")).toBe(true);
			expect(parseKey("\x1bz")).toBe("alt+z");

			setKittyProtocolActive(true);
			expect(matchesKey("\x1b ", "alt+space")).toBe(false);
			expect(parseKey("\x1b ")).toBe(undefined);
			expect(matchesKey("\x1b\b", "alt+backspace")).toBe(true);
			expect(parseKey("\x1b\b")).toBe("alt+backspace");
			expect(matchesKey("\x1b\x03", "ctrl+alt+c")).toBe(false);
			expect(parseKey("\x1b\x03")).toBe(undefined);
			expect(matchesKey("\x1bB", "alt+left")).toBe(false);
			expect(parseKey("\x1bB")).toBe(undefined);
			expect(matchesKey("\x1bF", "alt+right")).toBe(false);
			expect(parseKey("\x1bF")).toBe(undefined);
			expect(matchesKey("\x1ba", "alt+a")).toBe(false);
			expect(parseKey("\x1ba")).toBe(undefined);
			expect(matchesKey("\x1b1", "alt+1")).toBe(false);
			expect(parseKey("\x1b1")).toBe(undefined);
			expect(matchesKey("\x1b,", "alt+,")).toBe(false);
			expect(parseKey("\x1b,")).toBe(undefined);
			expect(matchesKey("\x1b.", "alt+.")).toBe(false);
			expect(parseKey("\x1b.")).toBe(undefined);
			expect(matchesKey("\x1by", "alt+y")).toBe(false);
			expect(parseKey("\x1by")).toBe(undefined);
			setKittyProtocolActive(false);
		});

		it("should match arrow keys", () => {
			expect(matchesKey("\x1b[A", "up")).toBe(true);
			expect(matchesKey("\x1b[B", "down")).toBe(true);
			expect(matchesKey("\x1b[C", "right")).toBe(true);
			expect(matchesKey("\x1b[D", "left")).toBe(true);
		});

		it("should match SS3 arrows and home/end", () => {
			expect(matchesKey("\x1bOA", "up")).toBe(true);
			expect(matchesKey("\x1bOB", "down")).toBe(true);
			expect(matchesKey("\x1bOC", "right")).toBe(true);
			expect(matchesKey("\x1bOD", "left")).toBe(true);
			expect(matchesKey("\x1bOH", "home")).toBe(true);
			expect(matchesKey("\x1bOF", "end")).toBe(true);
		});

		it("should match xterm Ctrl-modified viewport navigation", () => {
			expect(matchesKey("\x1b[1;5H", "ctrl+home")).toBe(true);
			expect(matchesKey("\x1b[1;5F", "ctrl+end")).toBe(true);
			expect(matchesKey("\x1b[5;5~", "ctrl+pageUp")).toBe(true);
			expect(matchesKey("\x1b[6;5~", "ctrl+pageDown")).toBe(true);
			expect(parseKey("\x1b[1;5H")).toBe("ctrl+home");
			expect(parseKey("\x1b[1;5F")).toBe("ctrl+end");
			expect(parseKey("\x1b[5;5~")).toBe("ctrl+pageUp");
			expect(parseKey("\x1b[6;5~")).toBe("ctrl+pageDown");
		});

		it("should match legacy function keys and clear", () => {
			expect(matchesKey("\x1bOP", "f1")).toBe(true);
			expect(matchesKey("\x1b[24~", "f12")).toBe(true);
			expect(matchesKey("\x1b[E", "clear")).toBe(true);
		});

		it("should match alt+arrows", () => {
			expect(matchesKey("\x1bp", "alt+up")).toBe(true);
			expect(matchesKey("\x1bp", "up")).toBe(false);
		});

		it("should match rxvt modifier sequences", () => {
			expect(matchesKey("\x1b[a", "shift+up")).toBe(true);
			expect(matchesKey("\x1bOa", "ctrl+up")).toBe(true);
			expect(matchesKey("\x1b[2$", "shift+insert")).toBe(true);
			expect(matchesKey("\x1b[2^", "ctrl+insert")).toBe(true);
			expect(matchesKey("\x1b[7$", "shift+home")).toBe(true);
		});
	});
});

describe("decodeKittyPrintable", () => {
	it("should decode Kitty keypad functional keys to printable characters", () => {
		expect(decodeKittyPrintable("\x1b[57399u")).toBe("0");
		expect(decodeKittyPrintable("\x1b[57400u")).toBe("1");
		expect(decodeKittyPrintable("\x1b[57409u")).toBe(".");
		expect(decodeKittyPrintable("\x1b[57410u")).toBe("/");
		expect(decodeKittyPrintable("\x1b[57411u")).toBe("*");
		expect(decodeKittyPrintable("\x1b[57412u")).toBe("-");
		expect(decodeKittyPrintable("\x1b[57413u")).toBe("+");
		expect(decodeKittyPrintable("\x1b[57415u")).toBe("=");
		expect(decodeKittyPrintable("\x1b[57416u")).toBe(",");
		expect(decodeKittyPrintable("\x1b[57417u")).toBe(undefined);
	});
});

describe("decodePrintableKey", () => {
	it("should decode printable xterm modifyOtherKeys sequences", () => {
		expect(decodePrintableKey("\x1b[27;2;69~")).toBe("E");
		expect(decodePrintableKey("\x1b[27;2;196~")).toBe("Ä");
		expect(decodePrintableKey("\x1b[27;2;32~")).toBe(" ");
		expect(decodePrintableKey("\x1b[27;2;13~")).toBe(undefined);
		expect(decodePrintableKey("\x1b[27;6;69~")).toBe(undefined);
	});
});

describe("parseKey", () => {
	describe("Kitty protocol with alternate keys", () => {
		it("should return Latin key name when base layout key is present", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base layout 'c'
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			expect(parseKey(cyrillicCtrlC)).toBe("ctrl+c");
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for Latin letters when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			const dvorakCtrlK = "\x1b[107::118;5u";
			expect(parseKey(dvorakCtrlK)).toBe("ctrl+k");
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for symbol keys when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			expect(parseKey(dvorakCtrlSlash)).toBe("ctrl+/");
			setKittyProtocolActive(false);
		});

		it("should return key name from codepoint when no base layout", () => {
			setKittyProtocolActive(true);
			const latinCtrlC = "\x1b[99;5u";
			expect(parseKey(latinCtrlC)).toBe("ctrl+c");
			setKittyProtocolActive(false);
		});

		it("should parse shifted uppercase CSI-u letters as shift+letter", () => {
			setKittyProtocolActive(true);
			expect(matchesKey("\x1b[69;2u", "shift+e")).toBe(true);
			expect(parseKey("\x1b[69;2u")).toBe("shift+e");
			setKittyProtocolActive(false);
		});

		it("should ignore Kitty CSI-u with unsupported modifiers", () => {
			setKittyProtocolActive(true);
			expect(parseKey("\x1b[99;17u")).toBe(undefined);
			setKittyProtocolActive(false);
		});
	});

	describe("Legacy key parsing", () => {
		it("should parse legacy Ctrl+letter", () => {
			setKittyProtocolActive(false);
			expect(parseKey("\x03")).toBe("ctrl+c");
			expect(parseKey("\x04")).toBe("ctrl+d");
		});

		it("should parse special keys", () => {
			expect(parseKey("\x1b")).toBe("escape");
			expect(parseKey("\t")).toBe("tab");
			expect(parseKey("\r")).toBe("enter");
			expect(parseKey("\n")).toBe("enter");
			expect(parseKey("\x00")).toBe("ctrl+space");
			expect(parseKey(" ")).toBe("space");
			expect(parseKey("1")).toBe("1");
			expect(matchesKey("1", "1")).toBe(true);
		});

		it("should parse arrow keys", () => {
			expect(parseKey("\x1b[A")).toBe("up");
			expect(parseKey("\x1b[B")).toBe("down");
			expect(parseKey("\x1b[C")).toBe("right");
			expect(parseKey("\x1b[D")).toBe("left");
		});

		it("should parse SS3 arrows and home/end", () => {
			expect(parseKey("\x1bOA")).toBe("up");
			expect(parseKey("\x1bOB")).toBe("down");
			expect(parseKey("\x1bOC")).toBe("right");
			expect(parseKey("\x1bOD")).toBe("left");
			expect(parseKey("\x1bOH")).toBe("home");
			expect(parseKey("\x1bOF")).toBe("end");
		});

		it("should parse legacy function and modifier sequences", () => {
			expect(parseKey("\x1bOP")).toBe("f1");
			expect(parseKey("\x1b[24~")).toBe("f12");
			expect(parseKey("\x1b[E")).toBe("clear");
			expect(parseKey("\x1b[2^")).toBe("ctrl+insert");
			expect(parseKey("\x1bp")).toBe("alt+up");
		});

		it("should parse double bracket pageUp", () => {
			expect(parseKey("\x1b[[5~")).toBe("pageUp");
		});
	});
});
