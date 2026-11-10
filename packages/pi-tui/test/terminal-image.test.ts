/**
 * Tests for terminal image detection and line handling
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { expect, describe, it } from "bun:test";
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
	getCapabilities,
	getGifDimensions,
	getJpegDimensions,
	getKittyImageMetadata,
	getKittyImagePlacement,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	imageFallback,
	isImageLine,
	parseImageCapabilityResponse,
	registerKittyImageMetadata,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
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
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
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
		return fn();
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
			expect(isImageLine(iterm2ImageLine)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			expect(isImageLine(lineWithTextAndImage)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			expect(isImageLine(longLineWithImage)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			expect(isImageLine(lineWithImageAtEnd)).toBe(true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			expect(isImageLine(minimalImageLine)).toBe(true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			expect(isImageLine(kittyImageLine)).toBe(true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			expect(isImageLine(lineWithTextAndKittyImage)).toBe(true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			expect(isImageLine(kittyWithPadding)).toBe(true);
		});
	});

	describe("Sixel image protocol", () => {
		it("should detect a sixel DCS sequence at start of line", () => {
			const sixelImageLine = "\x1bPq#0;2;0;0;0#1;2;100;100;0#1~~-\x1b\\";
			expect(isImageLine(sixelImageLine)).toBe(true);
		});

		it("should detect a sixel sequence after a cursor-up prefix (multi-row layout)", () => {
			// The Image component emits (rows-1) empty lines, then a cursor-up
			// CSI followed by the sixel payload on the last line.
			const multiRowSixelLine = "\x1b[5A\x1bPq#1;2;0;0;100;100#1~~-\x1b\\";
			expect(isImageLine(multiRowSixelLine)).toBe(true);
		});

		it("should not flag plain text that merely mentions sixel", () => {
			expect(isImageLine("sixel images are supported here")).toBe(false);
		});

		it("should not flag a non-sixel DCS sequence", () => {
			expect(isImageLine("\x1bP0;1znot-an-image\x1b\\")).toBe(false);
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

			expect(longLine.length > 300000).toBe(true);
			expect(isImageLine(longLine)).toBe(true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			expect(isImageLine(lineWithImage)).toBe(true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			expect(isImageLine(lineWithAnsiAndImage)).toBe(true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			expect(isImageLine(lineWithImageAndAnsi)).toBe(true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			expect(isImageLine(plainText)).toBe(false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			expect(isImageLine(ansiText)).toBe(false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			expect(isImageLine(cursorCodes)).toBe(false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			expect(isImageLine(partialSequence)).toBe(false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			expect(isImageLine(partialSequence)).toBe(false);
		});

		it("should not detect images in empty lines", () => {
			expect(isImageLine("")).toBe(false);
		});

		it("should not detect images in lines with newlines only", () => {
			expect(isImageLine("\n")).toBe(false);
			expect(isImageLine("\n\n")).toBe(false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			expect(isImageLine(mixedLine)).toBe(true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			expect(isImageLine(complexLine)).toBe(true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			expect(isImageLine(filePathLine)).toBe(false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("applies environment overrides", () => {
		expect(withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => detectCapabilities())).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
		expect(withEnv({ TERM_PROGRAM: "iterm.app", PI_HYPERLINKS: "0", PI_IMAGE_PROTOCOL: "none", PI_TRUE_COLOR: "0" }, () =>
				detectCapabilities(),
			)).toStrictEqual({ images: null, trueColor: false, hyperlinks: false });
	});

	it("preserves auto-detection for auto environment overrides", () => {
		expect(withEnv(
				{
					TERM_PROGRAM: "ghostty",
					PI_HYPERLINKS: "auto",
					PI_IMAGE_PROTOCOL: "auto",
					PI_TRUE_COLOR: "auto",
				},
				() => detectCapabilities(),
			)).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
	});

	it("applies and clears programmatic overrides", () => {
		withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => {
			setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false });
			try {
				expect(getCapabilities()).toStrictEqual({ images: null, trueColor: false, hyperlinks: false });
				setCapabilityOverrides({});
				expect(getCapabilities()).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
			} finally {
				setCapabilityOverrides({});
				resetCapabilitiesCache();
			}
		});
	});

	it("bypasses the tmux probe when hyperlinks are overridden", () => {
		let probed = false;
		const caps = withEnv(
			{ TMUX: "/tmp/tmux-1000/default,1234,0", PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty" },
			() =>
				detectCapabilities(() => {
					probed = true;
					return false;
				}),
		);
		expect(probed).toBe(false);
		expect(caps.hyperlinks).toBe(true);
		expect(caps.images).toBe("kitty");
	});

	it("enables hyperlinks under tmux when the client forwards them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe(null);
		});
	});

	it("disables hyperlinks under tmux when the client does not forward them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("checks tmux capability when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities(() => true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe(null);

			const caps2 = detectCapabilities(() => false);
			expect(caps2.hyperlinks).toBe(false);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("enables sixel for Windows Terminal (WT_SESSION)", () => {
		withEnv({ WT_SESSION: "{ffef530f-4fa0-4339-9fbb-2e3eadf21604}", TERM: "dumb" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("sixel");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via TERM_PROGRAM", () => {
		withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_SESSION_ID", () => {
		withEnv({ WARP_SESSION_ID: "some-session-id" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_TERMINAL_SESSION_UUID", () => {
		withEnv({ WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
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
				expect(caps.images).toBe(null);
				expect(caps.hyperlinks).toBe(true);
			},
		);
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables sixel images for Alacritty", () => {
		withEnv({ TERM_PROGRAM: "alacritty" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("sixel");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables sixel images for foot via TERM", () => {
		withEnv({ TERM: "foot" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("sixel");
		});
	});

	it("enables sixel images for mlterm via TERM and MLTERM", () => {
		withEnv({ TERM: "mlterm" }, () => {
			expect(detectCapabilities().images).toBe("sixel");
		});
		withEnv({ MLTERM: "1" }, () => {
			expect(detectCapabilities().images).toBe("sixel");
		});
	});

	it("enables sixel images for yaft, contour, and rio via TERM", () => {
		for (const term of ["yaft-256color", "contour", "rio"]) {
			withEnv({ TERM: term }, () => {
				expect(detectCapabilities().images, `TERM=${term}`).toBe("sixel");
			});
		}
	});

	it("keeps sixel images disabled under tmux even for sixel terminals", () => {
		withEnv({ TERM: "foot", TMUX: "/tmp/tmux-1000/default,1234,0" }, () => {
			const caps = detectCapabilities(() => true);
			expect(caps.images).toBe(null);
		});
	});

	it("enables Alacritty capabilities for Zed", () => {
		withEnv({ TERM_PROGRAM: "zed" }, () => {
			expect(detectCapabilities()).toStrictEqual({ images: null, trueColor: true, hyperlinks: true });
		});
	});

	it("enables sixel, truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe("sixel");
		});
	});

	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("does not inherit Windows Terminal truecolor through tmux", () => {
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.trueColor).toBe(false);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("trusts explicit truecolor hints through tmux", () => {
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});
});

describe("iTerm2 image encoding", () => {
	it("includes the decoded payload size in OSC 1337 metadata", () => {
		const sequence = encodeITerm2("AAAA", { width: 2, height: "auto" });
		expect(sequence).toBe("\x1b]1337;File=inline=1;size=3;width=2;height=auto:AAAA\x07");
	});
});

describe("sixel encoding", () => {
	it("wraps the palette and pixel data in a DCS sequence", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255); // 2x2 opaque white
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			expect(sequence.startsWith("\x1bP0;1q"), "must open with DCS").toBeTruthy();
			expect(sequence.endsWith("\x1b\\"), "must close with ST").toBeTruthy();
			expect(sequence.includes("#0;2;0;0;0"), "must define palette entry 0").toBeTruthy();
			expect(sequence.includes("#239;2;93;93;93"), "must define the last grayscale entry").toBeTruthy();
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("declares a transparent background and a 1:1 pixel aspect", () => {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255);
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			// Windows Terminal reads DCS P1 as the macro aspect (0 means 2:1) and
			// P2 as the background select (0 means an opaque fill), so both have
			// to be stated explicitly.
			expect(sequence.startsWith("\x1bP0;1q"), "P2=1 must select a transparent background").toBeTruthy();
			expect(sequence.includes('"1;1'), "raster attributes must declare a 1:1 aspect").toBeTruthy();
			expect(isImageLine(sequence), "the emitted sequence must survive line truncation").toBe(true);
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("returns the pen to the band start between color runs", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4);
			for (let y = 0; y < 2; y++) {
				pixels[(y * 2) * 4] = 255; // left column red
				pixels[(y * 2) * 4 + 3] = 255;
				pixels[(y * 2 + 1) * 4 + 1] = 255; // right column green
				pixels[(y * 2 + 1) * 4 + 3] = 255;
			}
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			const body = sequence.slice(sequence.indexOf("\x1bP0;1q") + 6, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// targetH rounds down to 18 rows -> 3 bands, each holding two color
			// runs, so each band needs one carriage return between them.
			const bands = pixelPart.split("-");
			expect(bands.length, "18 pixel rows emit 3 bands").toBe(3);
			for (const band of bands) {
				const runs = band.split("$");
				expect(runs.length, "each band holds a red and a green run").toBe(2);
				for (const run of runs) {
					expect(run.replace(/^#\d+/, "").length, "every color run spans the full width").toBe(20);
				}
			}
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("quantizes pure red to the 6x6x6 cube corner and paints full columns", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4);
			for (let i = 0; i < 4; i++) {
				pixels[i * 4] = 255; // R
				pixels[i * 4 + 3] = 255; // A
			}
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			expect(sequence.includes("#180;2;100;0;0"), "palette must define the red cube corner").toBeTruthy();
			const body = sequence.slice(sequence.indexOf("\x1bP0;1q") + 6, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// targetW = 2 cells x 10px = 20 columns; every pixel is red, so each
			// band emits `#180` followed by 20 chars of 63+63 ('~': all 6 rows lit).
			const firstBand = pixelPart.split("-")[0]!;
			expect(firstBand.startsWith("#180"), `expected a color selector, got ${JSON.stringify(firstBand.slice(0, 6))}`).toBeTruthy();
			expect(firstBand.slice("#180".length), "every column must paint all 6 rows red").toBe("~".repeat(20));
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
			expect(sequence.includes("#228;2;50;50;50"), "palette must define the matched gray step").toBeTruthy();
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("emits one band per 6 pixel rows separated by -", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(2 * 2 * 4).fill(255); // 2x2 white
			const sequence = encodeSixel(pixels, 2, 2, { maxWidthCells: 2 });
			const body = sequence.slice(sequence.indexOf("\x1bP0;1q") + 6, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// targetH rounds down to 18 pixel rows -> 3 bands (2 x - separator).
			// A single-color band needs no graphics carriage return.
			const dollars = (pixelPart.match(/\$/g) ?? []).length;
			const dashes = (pixelPart.match(/-/g) ?? []).length;
			expect(dollars, "one color per band needs no carriage return").toBe(0);
			expect(dashes, "3 bands emit 2 band separators").toBe(2);
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("downscales wide images to the requested cell box", () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const pixels = new Uint8Array(100 * 10 * 4).fill(255); // 100x10
			const sequence = encodeSixel(pixels, 100, 10, { maxWidthCells: 2 });
			const body = sequence.slice(sequence.indexOf("\x1bP0;1q") + 6, sequence.lastIndexOf("\x1b\\"));
			const pixelPart = body.slice(body.indexOf("#239;2;93;93;93") + "#239;2;93;93;93".length);
			// targetW = 2 cells x 10px = 20 columns; targetH rounds down to
			// 6 pixel rows -> a single band, so no separators.
			const dollars = (pixelPart.match(/\$/g) ?? []).length;
			const dashes = (pixelPart.match(/-/g) ?? []).length;
			expect(dollars, "one color per band needs no carriage return").toBe(0);
			expect(dashes, "a single band emits no separator").toBe(0);
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
			expect(lines.length, "2 rows -> 1 empty pad line + 1 sequence line").toBe(2);
			expect(lines[0]).toBe("");
			expect(lines[1].startsWith("\x1b[1A\x1bP0;1q"), "sequence line must move up then open DCS").toBeTruthy();
			expect(lines[1].endsWith("\x1b\\")).toBeTruthy();
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
			expect(lines.length).toBe(1);
			expect(lines[0].includes("[Image:"), "must fall back to the text marker").toBeTruthy();
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		expect(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;")).toBeTruthy();
	});

	it("suppresses Kitty replies for delete commands", () => {
		expect(deleteKittyImage(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		expect(deleteAllKittyImages()).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
		expect(deleteAllKittyPlacements()).toBe("\x1b_Ga=d,d=a,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			expect(result).toBeTruthy();
			expect(!result.sequence.includes(",C=1,")).toBeTruthy();
			expect(result.rows).toBe(2);
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
			expect(result).toBeTruthy();
			expect(result.sequence.includes(",C=1,")).toBeTruthy();
			expect(result.rows).toBe(2);
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
			expect(result).toBeTruthy();
			expect(getKittyImageMetadata(result.sequence)).toStrictEqual({
				imageId: 42,
				columns: 3,
				rows: 3,
				widthPx: 100,
				heightPx: 100,
			});
			expect(cropKittyImageLine(result.sequence, 2, 1).includes("y=66,h=34,r=1")).toBeTruthy();
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
		expect(placement).toBeTruthy();
		expect(placement.transmissionBytes).toBe(line.length - "left ".length - " right".length);
		expect(placement.estimatedDecodedBytes).toBe(100 * 100 * 4);
		expect(placement.sequence).toBe("\x1b_Ga=p,q=2,C=1,c=3,i=42,y=66,h=34,r=1\x1b\\");
		expect(placement.replacementLine).toBe(`left ${placement.sequence} right`);
		expect(!placement.replacementLine.includes("AAAA")).toBeTruthy();
	});

	it("honors maxHeightCells by reducing rendered width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			expect(result).toBeTruthy();
			expect(result.rows).toBe(5);
			expect(result.sequence.includes(",c=1,r=5")).toBeTruthy();
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
			expect(lines.length).toBe(5);
			expect(lines[0].includes(",c=1,r=5")).toBeTruthy();
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
			expect(typeof imageId).toBe("number");
			expect(lines[0].startsWith("\x1b_G")).toBeTruthy();
			expect(lines[0].includes(",C=1,")).toBeTruthy();
			expect(lines[0].includes(`,i=${imageId}`)).toBeTruthy();
			expect(lines[0].endsWith("\x1b\\")).toBeTruthy();
			expect(lines.slice(1, lines.length)).toStrictEqual([""]);
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
			expect(lines.length).toBe(1);
			expect(visibleWidth(lines[0]) <= width, `fallback line wider than ${width}: visible=${visibleWidth(lines[0])} raw=${JSON.stringify(lines[0])}`).toBeTruthy();
			expect(lines[0].includes("..."), "expected ellipsis when truncating long fallback path").toBeTruthy();
			expect(lines[0].includes("~"), "expected home-shortened path in fallback").toBeTruthy();
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("parseImageCapabilityResponse", () => {
	it("detects kitty from the graphics query OK reply", () => {
		expect(parseImageCapabilityResponse("\x1b_Gi=1;OK\x1b\\")).toStrictEqual({
			kind: "detected",
			protocol: "kitty",
		});
	});

	it("reports unsupported for the kitty ENOENT reply", () => {
		expect(parseImageCapabilityResponse("\x1b_Gi=1;ENOENT\x1b\\")).toStrictEqual({
			kind: "unsupported",
		});
	});

	it("detects sixel from a DA1 reply carrying param 62", () => {
		expect(parseImageCapabilityResponse("\x1b[?1;2;62c")).toStrictEqual({
			kind: "detected",
			protocol: "sixel",
		});
		expect(parseImageCapabilityResponse("\x1b[?62c")).toStrictEqual({
			kind: "detected",
			protocol: "sixel",
		});
	});

	it("detects sixel from the DEC DA1 param 4", () => {
		expect(parseImageCapabilityResponse("\x1b[?64;1;2;4c")).toStrictEqual({
			kind: "detected",
			protocol: "sixel",
		});
	});

	it("reports unsupported for a DA1 reply without a sixel parameter", () => {
		expect(parseImageCapabilityResponse("\x1b[?1;2;22c")).toStrictEqual({
			kind: "unsupported",
		});
	});

	it("returns null for unrelated input", () => {
		expect(parseImageCapabilityResponse("q")).toBe(null);
		expect(parseImageCapabilityResponse("\x1b[6;20;10t")).toBe(null);
		expect(parseImageCapabilityResponse("\x1b[?2004h")).toBe(null);
	});
});

describe("imageFallback", () => {
	it("shortens home-prefixed absolute paths without hyperlinks", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, abs);
			expect(result).toBe(`[Image: ~${sep}.pi${sep}agent${sep}shot.png [image/png] 1280x720]`);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps shortened absolute paths in OSC 8 file links when hyperlinks are enabled", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 10, heightPx: 10 }, abs);
			expect(result.includes("\x1b]8;;file://"), "expected OSC 8 file link").toBeTruthy();
			expect(result.includes(abs.replaceAll("\\", "/")) || result.includes(abs), "file URL should target absolute path").toBeTruthy();
			// Visible text must use ~/... not the expanded home path.
			const visible = result.replace(/\x1b\]8;;.*?\x1b\\/g, "");
			expect(visible).toBe(`[Image: ~${sep}.pi${sep}agent${sep}shot.png [image/png] 10x10]`);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("leaves bare basenames unchanged and does not hyperlink them", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const result = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "clankolas.png");
			expect(result).toBe("[Image: clankolas.png [image/png] 1x1]");
			expect(!result.includes("\x1b]8;"), "basename must not be hyperlinked").toBeTruthy();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("omits filename segment when not provided", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			expect(imageFallback("image/png", { widthPx: 8, heightPx: 6 })).toBe("[Image: [image/png] 8x6]");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		expect(result).toBe("\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		expect(result.startsWith("\x1b]8;;https://example.com\x1b\\")).toBeTruthy();
		expect(result.includes(styled)).toBeTruthy();
		expect(result.endsWith("\x1b]8;;\x1b\\")).toBeTruthy();
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		expect(result).toBe("\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		expect(result.includes("file:///home/user/README.md")).toBeTruthy();
		expect(result.includes("README.md")).toBeTruthy();
	});
});

describe("image dimension headers", () => {
	it("reads PNG dimensions from a payload far larger than its header", () => {
		const header = Buffer.alloc(24);
		header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		header.writeUInt32BE(13, 8);
		header.write("IHDR", 12, "ascii");
		header.writeUInt32BE(320, 16);
		header.writeUInt32BE(200, 20);
		const b64 = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024)]).toString("base64");

		expect(getPngDimensions(b64)).toEqual({ widthPx: 320, heightPx: 200 });
	});

	it("reads GIF dimensions", () => {
		const head = Buffer.alloc(10);
		head.write("GIF89a", 0, "ascii");
		head.writeUInt16LE(640, 6);
		head.writeUInt16LE(480, 8);
		expect(getGifDimensions(head.toString("base64"))).toEqual({ widthPx: 640, heightPx: 480 });
	});

	it("reads WebP dimensions", () => {
		const head = Buffer.alloc(30);
		head.write("RIFF", 0, "ascii");
		head.write("WEBP", 8, "ascii");
		head.write("VP8X", 12, "ascii");
		head[24] = 0x3f;
		head[25] = 0x00;
		head[26] = 0x00;
		head[27] = 0x27;
		head[28] = 0x00;
		head[29] = 0x00;
		expect(getWebpDimensions(head.toString("base64"))).toEqual({ widthPx: 64, heightPx: 40 });
	});

	it("finds the JPEG SOF marker behind APP segments larger than one window", () => {
		// A JPEG segment length is a uint16, so a large APP payload is split
		// across several segments; L counts the length field plus the payload,
		// and the next segment sits at marker + 2 + L.
		const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
		for (let index = 0; index < 4; index += 1) {
			const app = Buffer.alloc(2 + 2 + 60_000);
			app[0] = 0xff;
			app[1] = 0xe0;
			app.writeUInt16BE(app.length - 2, 2);
			parts.push(app);
		}
		const sof = Buffer.alloc(11);
		sof[0] = 0xff;
		sof[1] = 0xc0;
		sof.writeUInt16BE(sof.length - 2, 2);
		sof[4] = 0x08;
		sof.writeUInt16BE(200, 5);
		sof.writeUInt16BE(320, 7);
		parts.push(sof);
		const b64 = Buffer.concat(parts).toString("base64");

		expect(getJpegDimensions(b64)).toEqual({ widthPx: 320, heightPx: 200 });
	});
});
