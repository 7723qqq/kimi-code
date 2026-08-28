/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import {
	cropKittyImageLine,
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	encodeSixel,
	getKittyImageMetadata,
	getKittyImagePlacement,
	hyperlink,
	imageFallback,
	isImageLine,
	parseImageCapabilityResponse,
	registerKittyImageMetadata,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { visibleWidth } from "../src/utils.ts";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"MLTERM",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("Sixel image protocol", () => {
		it("should detect a sixel DCS sequence at start of line", () => {
			const sixelImageLine = "\x1bPq#0;2;0;0;0#1;2;100;100;0#1~~-\x1b\\";
			assert.strictEqual(isImageLine(sixelImageLine), true);
		});

		it("should detect a sixel sequence after a cursor-up prefix (multi-row layout)", () => {
			// The Image component emits (rows-1) empty lines, then a cursor-up
			// CSI followed by the sixel payload on the last line.
			const multiRowSixelLine = "\x1b[5A\x1bPq#1;2;0;0;100;100#1~~-\x1b\\";
			assert.strictEqual(isImageLine(multiRowSixelLine), true);
		});

		it("should not flag plain text that merely mentions sixel", () => {
			assert.strictEqual(isImageLine("sixel images are supported here"), false);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks under tmux when the client forwards them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("disables hyperlinks under tmux when the client does not forward them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("checks tmux capability when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities(() => true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);

			const caps2 = detectCapabilities(() => false);
			assert.strictEqual(caps2.hyperlinks, false);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables sixel for Windows Terminal (WT_SESSION)", () => {
		withEnv({ WT_SESSION: "{ffef530f-4fa0-4339-9fbb-2e3eadf21604}", TERM: "dumb" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "sixel");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via TERM_PROGRAM", () => {
		withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_SESSION_ID", () => {
		withEnv({ WARP_SESSION_ID: "some-session-id" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_TERMINAL_SESSION_UUID", () => {
		withEnv({ WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("disables images for Warp inside tmux", () => {
		withEnv(
			{
				TERM_PROGRAM: "WarpTerminal",
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TERM: "tmux-256color",
			},
			() => {
				const caps = detectCapabilities(() => true);
				assert.strictEqual(caps.images, null);
				assert.strictEqual(caps.hyperlinks, true);
			},
		);
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables sixel images for Alacritty", () => {
		withEnv({ TERM_PROGRAM: "alacritty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "sixel");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables sixel images for foot via TERM", () => {
		withEnv({ TERM: "foot" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "sixel");
		});
	});

	it("enables sixel images for mlterm via TERM and MLTERM", () => {
		withEnv({ TERM: "mlterm" }, () => {
			assert.strictEqual(detectCapabilities().images, "sixel");
		});
		withEnv({ MLTERM: "1" }, () => {
			assert.strictEqual(detectCapabilities().images, "sixel");
		});
	});

	it("enables sixel images for yaft, contour, and rio via TERM", () => {
		for (const term of ["yaft-256color", "contour", "rio"]) {
			withEnv({ TERM: term }, () => {
				assert.strictEqual(detectCapabilities().images, "sixel", `TERM=${term}`);
			});
		}
	});

	it("keeps sixel images disabled under tmux even for sixel terminals", () => {
		withEnv({ TERM: "foot", TMUX: "/tmp/tmux-1000/default,1234,0" }, () => {
			const caps = detectCapabilities(() => true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables sixel, truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, "sixel");
		});
	});

	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("does not inherit Windows Terminal truecolor through tmux", () => {
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.trueColor, false);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("trusts explicit truecolor hints through tmux", () => {
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});
});

describe("iTerm2 image encoding", () => {
	it("includes the decoded payload size in OSC 1337 metadata", () => {
		const sequence = encodeITerm2("AAAA", { width: 2, height: "auto" });
		assert.strictEqual(sequence, "\x1b]1337;File=inline=1;size=3;width=2;height=auto:AAAA\x07");
	});
});

describe("sixel encoding", () => {
	it("wraps the palette and pixel data in a DCS sequence", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255); // 2x2 opaque white
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			assert.ok(sequence.startsWith("\x1bPq"), "must open with DCS");
			assert.ok(sequence.endsWith("\x1b\\"), "must close with ST");
			assert.ok(sequence.includes("#0;2;0;0;0"), "must define palette entry 0");
			assert.ok(sequence.includes("#239;2;93;93;93"), "must define the last grayscale entry");
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("quantizes pure red to the 6x6x6 cube corner and emits one char per 6 bits", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4);
			for (let i = 0; i < 4; i++) {
				pixels[i * 4] = 255; // R
				pixels[i * 4 + 3] = 255; // A
			}
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			// Pure red -> cube index 36*5+0+0 = 180; six pixels of index 180
			// pack into 6 chars: 180 * (64^0..64^5) = 196341362100 -> "suuuuu".
			assert.ok(sequence.includes("#180;2;100;0;0"), "palette must define the red cube corner");
			const body = sequence.slice(sequence.indexOf("\x1bPq") + 4, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			assert.ok(pixelPart.startsWith("suuuuu"), `expected packed red group, got ${JSON.stringify(pixelPart.slice(0, 6))}`);
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("prefers the grayscale ramp for neutral pixels", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4);
			for (let i = 0; i < 4; i++) {
				pixels[i * 4] = 128;
				pixels[i * 4 + 1] = 128;
				pixels[i * 4 + 2] = 128;
				pixels[i * 4 + 3] = 255;
			}
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			// lum=128 -> gray step round((128-8)/10)=12 -> index 228, 50%.
			assert.ok(sequence.includes("#228;2;50;50;50"), "palette must define the matched gray step");
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("separates pixel groups with $ and pixel rows with -", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255); // 2x2 white
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			const body = sequence.slice(sequence.indexOf("\x1bPq") + 4, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// 2 cells x 10px = 20 target px per pixel row -> 4 groups (3 x $);
			// 20 pixel rows -> 19 x - separators.
			const dollars = (pixelPart.match(/\$/g) ?? []).length;
			const dashes = (pixelPart.match(/-/g) ?? []).length;
			assert.strictEqual(dollars, 60, "20 pixel rows x 3 group separators");
			assert.strictEqual(dashes, 19, "20 pixel rows emit 19 row separators");
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("downscales wide images to the requested cell box", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(100 * 10 * 4).fill(255); // 100x10
			const sequence = encodeSixel(pixels, 100, 10, { maxWidthCells: 2 });
			const body = sequence.slice(sequence.indexOf("\x1bPq") + 4, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// 2 cells x 10px = 20 target px per pixel row -> 4 groups (3 x $);
			// 10 pixel rows -> 9 x - separators.
			const dollars = (pixelPart.match(/\$/g) ?? []).length;
			const dashes = (pixelPart.match(/-/g) ?? []).length;
			assert.strictEqual(dollars, 30, "10 pixel rows x 3 group separators");
			assert.strictEqual(dashes, 9, "10 pixel rows emit 9 row separators");
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("renders pre-decoded pixels through the Image component with row padding", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255);
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2, pixels, pixelWidth: 2, pixelHeight: 2 },
				{ widthPx: 2, heightPx: 2 },
			);
			const lines = image.render(4);
			assert.strictEqual(lines.length, 2, "2 rows -> 1 empty pad line + 1 sequence line");
			assert.strictEqual(lines[0], "");
			assert.ok(lines[1].startsWith("\x1b[1A\x1bPq"), "sequence line must move up then open DCS");
			assert.ok(lines[1].endsWith("\x1b\\"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to text when sixel is active but no pixels are provided", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 2, heightPx: 2 },
			);
			const lines = image.render(40);
			assert.strictEqual(lines.length, 1);
			assert.ok(lines[0].includes("[Image:"), "must fall back to the text marker");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
	});

	it("suppresses Kitty replies for delete commands", () => {
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyPlacements(), "\x1b_Ga=d,d=a,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.ok(!result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			assert.ok(result);
			assert.ok(result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("registers metadata and crops a partially visible placement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage(
				"AAAA",
				{ widthPx: 100, heightPx: 100 },
				{ maxWidthCells: 3, imageId: 42, moveCursor: false },
			);
			assert.ok(result);
			assert.deepStrictEqual(getKittyImageMetadata(result.sequence), {
				imageId: 42,
				columns: 3,
				rows: 3,
				widthPx: 100,
				heightPx: 100,
			});
			assert.ok(cropKittyImageLine(result.sequence, 2, 1).includes("y=66,h=34,r=1"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("creates placement-only commands for uploaded and cropped images", () => {
		registerKittyImageMetadata({ imageId: 42, columns: 3, rows: 3, widthPx: 100, heightPx: 100 });
		const transmission = encodeKitty("A".repeat(8192), {
			columns: 3,
			rows: 3,
			imageId: 42,
			moveCursor: false,
		});
		const line = `left ${cropKittyImageLine(transmission, 2, 1)} right`;
		const placement = getKittyImagePlacement(line);
		assert.ok(placement);
		assert.strictEqual(placement.transmissionBytes, line.length - "left ".length - " right".length);
		assert.strictEqual(placement.estimatedDecodedBytes, 100 * 100 * 4);
		assert.strictEqual(placement.sequence, "\x1b_Ga=p,q=2,C=1,c=3,i=42,y=66,h=34,r=1\x1b\\");
		assert.strictEqual(placement.replacementLine, `left ${placement.sequence} right`);
		assert.ok(!placement.replacementLine.includes("AAAA"));
	});

	it("honors maxHeightCells by reducing rendered width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			assert.ok(result);
			assert.strictEqual(result.rows, 5);
			assert.ok(result.sequence.includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("caps Image component height to a square pixel box by default", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 10 },
				{ widthPx: 10, heightPx: 100 },
			);
			const lines = image.render(12);
			assert.strictEqual(lines.length, 5);
			assert.ok(lines[0].includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("places image sequence on first line with empty padding rows", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			assert.strictEqual(typeof imageId, "number");
			assert.ok(lines[0].startsWith("\x1b_G"));
			assert.ok(lines[0].includes(",C=1,"));
			assert.ok(lines[0].includes(`,i=${imageId}`));
			assert.ok(lines[0].endsWith("\x1b\\"));
			assert.deepStrictEqual(lines.slice(1, lines.length), [""]);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("truncates long image fallback lines to render width", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const longPath = join(
				homedir(),
				"images",
				`${"generated-image-with-a-very-long-absolute-path".repeat(4)}.png`,
			);
			const width = 40;
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` },
				{ filename: longPath },
				{ widthPx: 1280, heightPx: 720 },
			);
			const lines = image.render(width);
			assert.strictEqual(lines.length, 1);
			assert.ok(
				visibleWidth(lines[0]) <= width,
				`fallback line wider than ${width}: visible=${visibleWidth(lines[0])} raw=${JSON.stringify(lines[0])}`,
			);
			assert.ok(lines[0].includes("..."), "expected ellipsis when truncating long fallback path");
			assert.ok(lines[0].includes("~"), "expected home-shortened path in fallback");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("parseImageCapabilityResponse", () => {
	it("detects kitty from the graphics query OK reply", () => {
		assert.deepStrictEqual(parseImageCapabilityResponse("\x1b_Gi=1;OK\x1b\\"), {
			kind: "detected",
			protocol: "kitty",
		});
	});

	it("reports unsupported for the kitty ENOENT reply", () => {
		assert.deepStrictEqual(parseImageCapabilityResponse("\x1b_Gi=1;ENOENT\x1b\\"), {
			kind: "unsupported",
		});
	});

	it("detects sixel from a DA1 reply carrying param 62", () => {
		assert.deepStrictEqual(parseImageCapabilityResponse("\x1b[?1;2;62c"), {
			kind: "detected",
			protocol: "sixel",
		});
		assert.deepStrictEqual(parseImageCapabilityResponse("\x1b[?62c"), {
			kind: "detected",
			protocol: "sixel",
		});
	});

	it("reports unsupported for a DA1 reply without param 62", () => {
		assert.deepStrictEqual(parseImageCapabilityResponse("\x1b[?1;2;4;22c"), {
			kind: "unsupported",
		});
	});

	it("returns null for unrelated input", () => {
		assert.strictEqual(parseImageCapabilityResponse("q"), null);
		assert.strictEqual(parseImageCapabilityResponse("\x1b[6;20;10t"), null);
		assert.strictEqual(parseImageCapabilityResponse("\x1b[?2004h"), null);
	});
});

describe("imageFallback", () => {
	it("shortens home-prefixed absolute paths without hyperlinks", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, abs);
			assert.strictEqual(
				result,
				`[Image: ~${sep}.pi${sep}agent${sep}shot.png [image/png] 1280x720]`,
			);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps shortened absolute paths in OSC 8 file links when hyperlinks are enabled", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 10, heightPx: 10 }, abs);
			assert.ok(result.includes("\x1b]8;;file://"), "expected OSC 8 file link");
			assert.ok(
				result.includes(abs.replaceAll("\\", "/")) || result.includes(abs),
				"file URL should target absolute path",
			);
			// Visible text must use ~/... not the expanded home path.
			const visible = result.replace(/\x1b\]8;;.*?\x1b\\/g, "");
			assert.strictEqual(
				visible,
				`[Image: ~${sep}.pi${sep}agent${sep}shot.png [image/png] 10x10]`,
			);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("leaves bare basenames unchanged and does not hyperlink them", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const result = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "clankolas.png");
			assert.strictEqual(result, "[Image: clankolas.png [image/png] 1x1]");
			assert.ok(!result.includes("\x1b]8;"), "basename must not be hyperlinked");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("omits filename segment when not provided", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			assert.strictEqual(imageFallback("image/png", { widthPx: 8, heightPx: 6 }), "[Image: [image/png] 8x6]");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});
