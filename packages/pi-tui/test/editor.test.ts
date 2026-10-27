import assert from "node:assert";
import { expect, describe, it, setSystemTime } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { PasteBurst } from "../src/paste-burst.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

/** Standard applyCompletion that replaces prefix with item.value */
function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] || "";
	const before = line.slice(0, cursorCol - prefix.length);
	const after = line.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = before + item.value + after;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("PasteBurst", () => {
	it("does not suppress Enter for slow typing", () => {
		const burst = new PasteBurst();
		burst.onPlainChar(0);
		burst.onPlainChar(20);

		expect(burst.shouldInsertNewlineInsteadOfSubmit(40)).toBe(false);
	});

	it("suppresses Enter during a rapid paste-like burst", () => {
		const burst = new PasteBurst();
		burst.onPlainChar(0);
		burst.onPlainChar(1);
		burst.onPlainChar(2);
		burst.onPlainChar(3);
		burst.onPlainChar(4);
		burst.onPlainChar(5);
		burst.onPlainChar(6);
		burst.onPlainChar(7);

		expect(burst.shouldInsertNewlineInsteadOfSubmit(8)).toBe(true);
	});

	it("keeps suppressing Enter briefly after a burst", () => {
		const burst = new PasteBurst();
		burst.onPlainChar(0);
		burst.onPlainChar(1);
		burst.onPlainChar(2);
		burst.onPlainChar(3);
		burst.onPlainChar(4);
		burst.onPlainChar(5);
		burst.onPlainChar(6);
		burst.onPlainChar(7);

		expect(burst.shouldInsertNewlineInsteadOfSubmit(100)).toBe(true);
		expect(burst.shouldInsertNewlineInsteadOfSubmit(200)).toBe(false);
	});

	it("resets after explicit paste handling", () => {
		const burst = new PasteBurst();
		burst.onPlainChar(0);
		burst.onPlainChar(1);
		burst.onPlainChar(2);
		burst.onPlainChar(3);
		burst.onPlainChar(4);
		burst.onPlainChar(5);
		burst.onPlainChar(6);
		burst.onPlainChar(7);
		burst.reset();

		expect(burst.shouldInsertNewlineInsteadOfSubmit(8)).toBe(false);
	});
});

describe("Editor component", () => {
	describe("Prompt history navigation", () => {
		it("does nothing on Up arrow when history is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[A"); // Up arrow

			expect(editor.getText()).toBe("");
		});

		it("shows most recent history entry on Up arrow when editor is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first prompt");
			editor.addToHistory("second prompt");

			editor.handleInput("\x1b[A"); // Up arrow

			expect(editor.getText()).toBe("second prompt");
		});

		it("cycles through history entries on repeated Up arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("\x1b[A"); // Up - shows "third"
			expect(editor.getText()).toBe("third");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[A"); // Up - shows "first"
			expect(editor.getText()).toBe("first");

			editor.handleInput("\x1b[A"); // Up - stays at "first" (oldest)
			expect(editor.getText()).toBe("first");
		});

		it("jumps to start before entering history from a non-empty draft", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("prompt");
			editor.setText("draft");
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[D");

			editor.handleInput("\x1b[A"); // Up - jumps to start before history browsing
			expect(editor.getText()).toBe("draft");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1b[A"); // Up at start - shows "prompt"
			expect(editor.getText()).toBe("prompt");

			editor.handleInput("\x1b[B"); // Down - restores draft
			expect(editor.getText()).toBe("draft");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});

		it("navigates forward through history with Down arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");
			editor.setText("draft");

			// Go to oldest
			editor.handleInput("\x1b[A"); // start of draft
			editor.handleInput("\x1b[A"); // third
			editor.handleInput("\x1b[A"); // second
			editor.handleInput("\x1b[A"); // first

			// Navigate back
			editor.handleInput("\x1b[B"); // second
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[B"); // third
			expect(editor.getText()).toBe("third");

			editor.handleInput("\x1b[B"); // draft
			expect(editor.getText()).toBe("draft");
		});

		it("exits history mode when typing a character", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("old prompt");

			editor.handleInput("\x1b[A"); // Up - shows "old prompt"
			editor.handleInput("x"); // Type a character - exits history mode

			expect(editor.getText()).toBe("xold prompt");
		});

		it("exits history mode on setText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			editor.setText(""); // External clear

			// Up should start fresh from most recent
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("second");
		});

		it("does not add empty strings to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("");
			editor.addToHistory("   ");
			editor.addToHistory("valid");

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("valid");

			// Should not have more entries
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("valid");
		});

		it("does not add consecutive duplicates to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("same");
			editor.addToHistory("same");
			editor.addToHistory("same");

			editor.handleInput("\x1b[A"); // "same"
			expect(editor.getText()).toBe("same");

			editor.handleInput("\x1b[A"); // stays at "same" (only one entry)
			expect(editor.getText()).toBe("same");
		});

		it("allows non-consecutive duplicates in history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("first"); // Not consecutive, should be added

			editor.handleInput("\x1b[A"); // "first"
			expect(editor.getText()).toBe("first");

			editor.handleInput("\x1b[A"); // "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[A"); // "first" (older one)
			expect(editor.getText()).toBe("first");
		});

		it("uses cursor movement instead of history when editor has content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("history item");
			editor.setText("line1\nline2");

			// Cursor is at end of line2, Up should move to line1
			editor.handleInput("\x1b[A"); // Up - cursor movement

			// Insert character to verify cursor position
			editor.handleInput("X");

			// X should be inserted in line1, not replace with history
			expect(editor.getText()).toBe("line1X\nline2");
		});

		it("limits history to 100 entries", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add 105 entries
			for (let i = 0; i < 105; i++) {
				editor.addToHistory(`prompt ${i}`);
			}

			// Navigate to oldest
			for (let i = 0; i < 100; i++) {
				editor.handleInput("\x1b[A");
			}

			// Should be at entry 5 (oldest kept), not entry 0
			expect(editor.getText()).toBe("prompt 5");

			// One more Up should not change anything
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("prompt 5");
		});

		it("places cursor at start after browsing history upward", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("older entry");
			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // Up - shows multi-line entry at start
			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1b[A"); // Up again - immediately navigates to older entry
			expect(editor.getText()).toBe("older entry");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});

		it("places cursor at end after browsing history downward", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("older entry");
			editor.addToHistory("line1\nline2\nline3");
			editor.addToHistory("newer entry");

			editor.handleInput("\x1b[A"); // newer entry
			editor.handleInput("\x1b[A"); // multi-line entry
			editor.handleInput("\x1b[A"); // older entry

			editor.handleInput("\x1b[B"); // Down - shows multi-line entry at end
			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 5 });

			editor.handleInput("\x1b[B"); // Down again - immediately navigates to newer entry
			expect(editor.getText()).toBe("newer entry");
		});

		it("allows opposite-direction cursor movement within multi-line history entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // Up - shows entry at start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1b[B"); // Down - cursor moves to line2
			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			editor.handleInput("\x1b[A"); // Up - cursor moves back to line1
			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});
	});

	describe("history filter", () => {
		it("visits all entries when no filter is set", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("first");
			editor.addToHistory("second");

			editor.handleInput("\x1b[A"); // Up - "second"
			expect(editor.getText()).toBe("second");
			editor.handleInput("\x1b[A"); // Up - "first"
			expect(editor.getText()).toBe("first");
		});

		it("skips entries that do not pass the filter on Up", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("prompt-a");
			editor.addToHistory("!cmd-b");
			editor.addToHistory("prompt-c");
			// history: ["prompt-c", "!cmd-b", "prompt-a"]
			editor.setHistoryFilter((entry) => entry.startsWith("!"));

			editor.handleInput("\x1b[A"); // Up - "!cmd-b" (skips "prompt-c")
			expect(editor.getText()).toBe("!cmd-b");

			editor.handleInput("\x1b[A"); // Up - no more shell entries, stays
			expect(editor.getText()).toBe("!cmd-b");
		});

		it("skips entries that do not pass the filter on Down", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("!cmd-a");
			editor.addToHistory("prompt-b");
			editor.addToHistory("!cmd-c");
			// history: ["!cmd-c", "prompt-b", "!cmd-a"]
			editor.setHistoryFilter((entry) => entry.startsWith("!"));

			editor.handleInput("\x1b[A"); // Up - "!cmd-c"
			expect(editor.getText()).toBe("!cmd-c");
			editor.handleInput("\x1b[A"); // Up - "!cmd-a" (skips "prompt-b")
			expect(editor.getText()).toBe("!cmd-a");
			editor.handleInput("\x1b[B"); // Down - "!cmd-c" (skips "prompt-b")
			expect(editor.getText()).toBe("!cmd-c");
		});

		it("does nothing on Up when no entry passes the filter", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("prompt-a");
			editor.addToHistory("prompt-b");
			editor.setHistoryFilter((entry) => entry.startsWith("!"));

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("");
		});

		it("still restores the draft with a filter active", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("!cmd");
			editor.setHistoryFilter((entry) => entry.startsWith("!"));
			editor.setText("draft");
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[D");

			editor.handleInput("\x1b[A"); // to line start
			editor.handleInput("\x1b[A"); // recall "!cmd"
			expect(editor.getText()).toBe("!cmd");

			editor.handleInput("\x1b[B"); // restore draft
			expect(editor.getText()).toBe("draft");
		});
	});

	describe("onRecall", () => {
		it("uses the returned text instead of the stored entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("!cmd");
			editor.onRecall = (entry) => (entry.startsWith("!") ? entry.slice(1) : undefined);

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("cmd");
		});

		it("uses the stored entry when onRecall returns undefined", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("prompt");
			editor.onRecall = () => undefined;

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("prompt");
		});

		it("passes the navigation direction to onRecall", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("a");
			editor.addToHistory("b");
			const directions: Array<1 | -1> = [];
			editor.onRecall = (_entry, direction) => {
				directions.push(direction);
				return undefined;
			};

			editor.handleInput("\x1b[A"); // Up -> "b" (-1)
			editor.handleInput("\x1b[A"); // Up -> "a" (-1)
			editor.handleInput("\x1b[B"); // Down -> "b" (1)
			expect(directions).toStrictEqual([-1, -1, 1]);
		});
	});

	describe("history draft host state", () => {
		it("saves host state on entering browse and restores it on draft return", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("entry");
			let restored: unknown;
			editor.onHistoryDraftSave = () => "prompt-mode";
			editor.onHistoryDraftRestore = (state) => {
				restored = state;
			};

			editor.handleInput("\x1b[A"); // Up - recall "entry", saves host state
			expect(editor.getText()).toBe("entry");
			expect(restored).toBe(undefined);

			editor.handleInput("\x1b[B"); // Down - restore draft
			expect(editor.getText()).toBe("");
			expect(restored).toBe("prompt-mode");
		});

		it("does not restore host state when leaving browse by typing", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("entry");
			let restored = false;
			editor.onHistoryDraftSave = () => "state";
			editor.onHistoryDraftRestore = () => {
				restored = true;
			};

			editor.handleInput("\x1b[A"); // recall "entry"
			editor.handleInput("x"); // type - exits browse without restoring draft
			expect(restored).toBe(false);
		});

		it("saves and restores host state across multiple browse sessions", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.addToHistory("entry");
			let count = 0;
			editor.onHistoryDraftSave = () => "state";
			editor.onHistoryDraftRestore = () => {
				count++;
			};

			editor.handleInput("\x1b[A"); // recall
			editor.handleInput("\x1b[B"); // restore draft (count=1)
			editor.handleInput("\x1b[A"); // recall again
			editor.handleInput("\x1b[B"); // restore draft again (count=2)
			expect(count).toBe(2);
		});
	});

	describe("public state accessors", () => {
		it("returns cursor position", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });

			editor.handleInput("\x1b[D"); // Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 2 });
		});

		it("returns lines as a defensive copy", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("a\nb");

			const lines = editor.getLines();
			expect(lines).toStrictEqual(["a", "b"]);

			lines[0] = "mutated";
			expect(editor.getLines()).toStrictEqual(["a", "b"]);
		});
	});

	describe("Paste burst fallback", () => {
		it("inserts a newline instead of submitting during a rapid burst", () => {
			// Freeze the clock so the 8 synchronous keystrokes are all seen as one
			// burst regardless of host speed or scheduler jitter (the production
			// heuristic uses an 8ms inter-char interval, which a slow CI runner can
			// exceed between synchronous calls).
			setSystemTime(1000);
			try {
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				let submitted = false;
				editor.onSubmit = () => {
					submitted = true;
				};

				editor.handleInput("a");
				editor.handleInput("b");
				editor.handleInput("c");
				editor.handleInput("d");
				editor.handleInput("e");
				editor.handleInput("f");
				editor.handleInput("g");
				editor.handleInput("h");
				editor.handleInput("\r");

				expect(submitted).toBe(false);
				expect(editor.getText()).toBe("abcdefgh\n");
			} finally {
				setSystemTime();
			}
		});

		it("can be disabled", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { disablePasteBurst: true });
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");
			editor.handleInput("\r");

			expect(submitted).toBe("abc");
		});

		it("resets when DEL backspace arrives after a burst", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");
			editor.handleInput("d");
			editor.handleInput("e");
			editor.handleInput("f");
			editor.handleInput("g");
			editor.handleInput("h");
			editor.handleInput("\x7f");
			editor.handleInput("\r");

			expect(submitted).toBe("abcdefg");
		});
	});

	describe("Backslash+Enter newline workaround", () => {
		it("inserts backslash immediately (no buffering)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");

			// Backslash should be visible immediately, not buffered
			expect(editor.getText()).toBe("\\");
		});

		it("converts standalone backslash to newline on Enter", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\r");

			expect(editor.getText()).toBe("\n");
		});

		it("inserts backslash normally when followed by other characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("x");

			expect(editor.getText()).toBe("\\x");
		});

		it("does not trigger newline when backslash is not immediately before cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = false;

			editor.onSubmit = () => {
				submitted = true;
			};

			editor.handleInput("\\");
			editor.handleInput("x");
			editor.handleInput("\r");

			// Should submit, not insert newline (backslash not at cursor)
			expect(submitted).toBe(true);
		});

		it("only removes one backslash when multiple are present", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\\");
			editor.handleInput("\\");
			expect(editor.getText()).toBe("\\\\\\");

			editor.handleInput("\r");
			// Only the last backslash is removed, newline inserted
			expect(editor.getText()).toBe("\\\\\n");
		});
	});

	describe("Kitty CSI-u handling", () => {
		it("ignores printable CSI-u sequences with unsupported modifiers", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[99;9u");

			expect(editor.getText()).toBe("");
		});

		it("inserts shifted CSI-u letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[69;2u");

			expect(editor.getText()).toBe("E");
		});

		it("inserts shifted xterm modifyOtherKeys letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[27;2;69~");

			expect(editor.getText()).toBe("E");
		});
	});

	describe("Unicode text editing behavior", () => {
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("H");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput(" ");
			editor.handleInput("😀");

			const text = editor.getText();
			expect(text).toBe("Hello äöü 😀");
		});

		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Delete the last character (ü)
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			expect(text).toBe("äö");
		});

		it("deletes multi-code-unit emojis with single Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");

			// Delete the last emoji (👍) - single backspace deletes whole grapheme cluster
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			expect(text).toBe("😀");
		});

		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Move cursor left twice
			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("\x1b[D"); // Left arrow

			// Insert 'x' in the middle
			editor.handleInput("x");

			const text = editor.getText();
			expect(text).toBe("äxöü");
		});

		it("moves cursor across multi-code-unit emojis with single arrow key", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");
			editor.handleInput("🎉");

			// Move cursor left over last emoji (🎉) - single arrow moves over whole grapheme
			editor.handleInput("\x1b[D"); // Left arrow

			// Move cursor left over second emoji (👍)
			editor.handleInput("\x1b[D");

			// Insert 'x' between first and second emoji
			editor.handleInput("x");

			const text = editor.getText();
			expect(text).toBe("😀x👍🎉");
		});

		it("preserves umlauts across line breaks", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput("\n"); // new line
			editor.handleInput("Ä");
			editor.handleInput("Ö");
			editor.handleInput("Ü");

			const text = editor.getText();
			expect(text).toBe("äöü\nÄÖÜ");
		});

		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Simulate bracketed paste / programmatic replacement
			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			const text = editor.getText();
			expect(text).toBe("Hällö Wörld! 😀 äöüÄÖÜß");
		});

		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\x01"); // Ctrl+A (move to start)
			editor.handleInput("x"); // Insert at start

			const text = editor.getText();
			expect(text).toBe("xab");
		});

		it("deletes words correctly with Ctrl+W and Alt+Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Basic word deletion
			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W
			expect(editor.getText()).toBe("foo bar ");

			// Trailing whitespace
			editor.setText("foo bar   ");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo ");

			// Punctuation run
			editor.setText("foo bar...");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo bar");

			// ASCII punctuation inside Intl word-like segments preserves old boundaries
			editor.setText("foo.bar");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo.");

			editor.setText("foo:bar");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo:");

			// Delete across multiple lines
			editor.setText("line one\nline two");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("line one\nline ");

			// Delete empty line (merge)
			editor.setText("line one\n");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("line one");

			// Grapheme safety (emoji as a word)
			editor.setText("foo 😀😀 bar");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo 😀😀 ");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo ");

			// Alt+Backspace
			editor.setText("foo bar");
			editor.handleInput("\x1b\x7f"); // Alt+Backspace (legacy)
			expect(editor.getText()).toBe("foo ");
		});

		it("navigates words correctly with Ctrl+Left/Right", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar... baz");
			// Cursor at end

			// Move left over baz
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 }); // after '...'

			// Move left over punctuation
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // after 'bar'

			// Move left over bar
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 }); // after 'foo '

			// Move right over bar
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // at end of 'bar'

			// Move right over punctuation run
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 }); // after '...'

			// Move right skips space and lands after baz
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 14 }); // end of line

			// Test forward from start with leading whitespace
			editor.setText("   foo bar");
			editor.handleInput("\x01"); // Ctrl+A to go to start
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 }); // after 'foo'

			// ASCII punctuation inside Intl word-like segments preserves old boundaries
			editor.setText("foo.bar baz");
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over baz
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over bar
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 });
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over .
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over foo
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over .
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 });
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over bar
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 });
		});

		it("stops at fullwidth Chinese punctuation (issue #4972)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 你好，世界 = 你好(0-2) ，(2-3) 世界(3-5)
			editor.setText("你好，世界");
			// Cursor at end (col 5)

			// Move left over 世界
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 }); // after ，

			// Move left over ，
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 2 }); // after 你好

			// Move left over 你好
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 }); // start

			// Move right over 你好
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 2 }); // after 你好

			// Move right over ，
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 }); // after ，

			// Move right over 世界
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 }); // end
		});

		it("handles mixed CJK and ASCII word movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "hello你好，world世界" = hello(0-5) 你好(5-7) ，(7-8) world(8-13) 世界(13-15)
			editor.setText("hello你好，world世界");
			// Cursor at end (col 15)

			// Move left over 世界
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 13 }); // after 'world'

			// Move left over world
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 }); // after ，

			// Move left over ，
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // after 你好

			// Move left over 你好
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 }); // after 'hello'

			// Move left over hello
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 }); // start

			// Forward from start
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 }); // after 'hello'

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // after 你好

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 }); // after ，

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 13 }); // after 'world'

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 15 }); // end
		});
	});

	describe("Scroll indicators", () => {
		it("centers scroll indicators on wide borders", () => {
			const width = 40;
			const editor = new Editor(createTestTUI(width), defaultEditorTheme);
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			editor.render(width);
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			const lines = editor.render(width);
			expect(stripVTControlCharacters(lines[0]!)).toBe(`${"─".repeat(15)} ↑ 9 more ${"─".repeat(15)}`);
			expect(stripVTControlCharacters(lines.at(-1)!)).toBe(`${"─".repeat(15)} ↓ 4 more ${"─".repeat(15)}`);
		});

		it("keeps truncated scroll indicators within width and preserves their color (issue #6962)", () => {
			const width = 10;
			const borderColor = (text: string) => `\x1b[35m${text}\x1b[39m`;
			const editor = new Editor(createTestTUI(width), { ...defaultEditorTheme, borderColor });
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			// Render once to initialize wrapping, then move the cursor so content remains above and below the viewport.
			editor.render(width);
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			const lines = editor.render(width);
			const topBorder = lines[0]!;
			const bottomBorder = lines.at(-1)!;

			expect(String(stripVTControlCharacters(topBorder))).toMatch(/^─── ↑/);
			expect(String(stripVTControlCharacters(bottomBorder))).toMatch(/^─── ↓/);
			expect(topBorder).toBe(borderColor(stripVTControlCharacters(topBorder)));
			expect(bottomBorder).toBe(borderColor(stripVTControlCharacters(bottomBorder)));
			for (const line of lines) {
				expect(visibleWidth(line), `line exceeds width ${width}: ${JSON.stringify(line)}`).toBe(width);
			}
		});
	});

	describe("Grapheme-aware text wrapping", () => {
		it("wraps lines correctly when text contains wide emojis", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			// ✅ is 2 columns wide, so "Hello ✅ World" is 14 columns
			editor.setText("Hello ✅ World");
			const lines = editor.render(width);

			// All content lines (between borders) should fit within width
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth, `Line ${i} has width ${lineWidth}, expected ${width}`).toBe(width);
			}
		});

		it("wraps long text with emojis at correct positions", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10;

			// Each ✅ is 2 columns. "✅✅✅✅✅" = 10 columns, fits exactly
			// "✅✅✅✅✅✅" = 12 columns, needs wrap
			editor.setText("✅✅✅✅✅✅");
			const lines = editor.render(width);

			// Should have 2 content lines (plus 2 border lines)
			// First line: 5 emojis (10 cols), second line: 1 emoji (2 cols) + padding
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth, `Line ${i} has width ${lineWidth}, expected ${width}`).toBe(width);
			}
		});

		it("renders isolated Thai and Lao AM clusters without width drift", () => {
			for (const text of ["ำabc", "ຳabc"]) {
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				const width = 8;
				editor.setText(text);

				for (const line of editor.render(width)) {
					expect(visibleWidth(line), `line width drift for ${JSON.stringify(text)}: ${line}`).toBe(width);
				}
			}
		});

		it("wraps CJK characters correctly (each is 2 columns wide)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // +1 col reserved for cursor

			// Each CJK char is 2 columns. "日本語テスト" = 6 chars = 12 columns
			editor.setText("日本語テスト");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth, `Line ${i} has width ${lineWidth}, expected ${width}`).toBe(width);
			}

			// Verify content split correctly
			const contentLines = lines.slice(1, -1).map((l) => stripVTControlCharacters(l).trim());
			expect(contentLines.length).toBe(2);
			expect(contentLines[0]).toBe("日本語テス"); // 5 chars = 10 columns
			expect(contentLines[1]).toBe("ト"); // 1 char = 2 columns (+ padding)
		});

		it("handles mixed ASCII and wide characters in wrapping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 15 + 1; // +1 col reserved for cursor

			// "Test ✅ OK 日本" = 4 + 1 + 2 + 1 + 2 + 1 + 4 = 15 columns (fits in width-1=15)
			editor.setText("Test ✅ OK 日本");
			const lines = editor.render(width);

			// Should fit in one content line
			const contentLines = lines.slice(1, -1);
			expect(contentLines.length).toBe(1);

			const lineWidth = visibleWidth(contentLines[0]!);
			expect(lineWidth).toBe(width);
		});

		it("renders cursor correctly on wide characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("A✅B");
			// Cursor should be at end (after B)
			const lines = editor.render(width);

			// The cursor (reverse video space) should be visible
			const contentLine = lines[1]!;
			expect(contentLine.includes("\x1b[7m"), "Should have reverse video cursor").toBeTruthy();

			// Line should still be correct width
			expect(visibleWidth(contentLine)).toBe(width);
		});

		it("does not exceed terminal width with emoji at wrap boundary", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 11;

			// "0123456789✅" = 10 ASCII + 2-wide emoji = 12 columns
			// Should wrap before the emoji since it would exceed width
			editor.setText("0123456789✅");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth <= width, `Line ${i} has width ${lineWidth}, exceeds max ${width}`).toBeTruthy();
			}
		});

		it("shows cursor at end of line before wrap, wraps on next char", () => {
			const width = 10;
			for (const paddingX of [0, 1]) {
				const editor = new Editor(createTestTUI(width + paddingX), defaultEditorTheme, { paddingX });

				// Type 9 chars → fills layoutWidth exactly, cursor at end on same line
				for (const ch of "aaaaaaaaa") editor.handleInput(ch);
				let lines = editor.render(width + paddingX);
				let contentLines = lines.slice(1, -1);
				expect(contentLines.length, "Should be 1 content line before wrap").toBe(1);
				expect(contentLines[0]!.endsWith("\x1b[7m \x1b[0m"), "Cursor should be at end of line").toBeTruthy();

				// Type 1 more → text wraps to second line
				editor.handleInput("a");
				lines = editor.render(width + paddingX);
				contentLines = lines.slice(1, -1);
				expect(contentLines.length, "Should wrap to 2 content lines").toBe(2);
			}
		});
	});

	describe("Word wrapping", () => {
		it("wraps at word boundaries instead of mid-word", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("Hello world this is a test of word wrapping functionality");
			const lines = editor.render(width);

			// Get content lines (between borders)
			const contentLines = lines.slice(1, -1).map((l) => stripVTControlCharacters(l).trim());

			// Should NOT break mid-word
			// Line 1 should end with a complete word
			expect(!contentLines[0]!.endsWith("-"), "Line should not end with hyphen (mid-word break)").toBeTruthy();

			// Each content line should be complete words
			for (const line of contentLines) {
				// Words at end of line should be complete (no partial words)
				const lastChar = line.trimEnd().slice(-1);
				expect(lastChar === "" || /[\w.,!?;:]/.test(lastChar), `Line ends unexpectedly with: "${lastChar}"`).toBeTruthy();
			}
		});

		it("does not start lines with leading whitespace after word wrap", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("Word1 Word2 Word3 Word4 Word5 Word6");
			const lines = editor.render(width);

			// Get content lines (between borders)
			const contentLines = lines.slice(1, -1);

			// No line should start with whitespace (except for padding at the end)
			for (let i = 0; i < contentLines.length; i++) {
				const line = stripVTControlCharacters(contentLines[i]!);
				const trimmedStart = line.trimStart();
				// The line should either be all padding or start with a word character
				if (trimmedStart.length > 0) {
					expect(!/^\s+\S/.test(line.trimEnd()), `Line ${i} starts with unexpected whitespace before content`).toBeTruthy();
				}
			}
		});

		it("breaks long words (URLs) at character level", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 30;

			editor.setText("Check https://example.com/very/long/path/that/exceeds/width here");
			const lines = editor.render(width);

			// All lines should fit within width
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth, `Line ${i} has width ${lineWidth}, expected ${width}`).toBe(width);
			}
		});

		it("preserves multiple spaces within words on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 50;

			editor.setText("Word1   Word2    Word3");
			const lines = editor.render(width);

			const contentLine = stripVTControlCharacters(lines[1]!).trim();
			// Multiple spaces should be preserved
			expect(contentLine.includes("Word1   Word2"), "Multiple spaces should be preserved").toBeTruthy();
		});

		it("handles empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("");
			const lines = editor.render(width);

			// Should have border + empty content + border
			expect(lines.length).toBe(3);
		});

		it("handles single word that fits exactly", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // +1 col reserved for cursor

			editor.setText("1234567890");
			const lines = editor.render(width);

			// Should have exactly 3 lines (top border, content, bottom border)
			expect(lines.length).toBe(3);
			const contentLine = stripVTControlCharacters(lines[1]!);
			expect(contentLine.includes("1234567890"), "Content should contain the word").toBeTruthy();
		});

		it("wraps word to next line when it ends exactly at terminal width", () => {
			// "hello " (6) + "world" (5) = 11, but "world" is non-whitespace ending at width.
			// Thus, wrap it to next line. The trailing space stays with "hello" on line 1
			const chunks = wordWrapLine("hello world test", 11);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("hello ");
			expect(chunks[1]!.text).toBe("world test");
		});

		it("keeps whitespace at terminal width boundary on same line", () => {
			// "hello world " is exactly 12 chars (including trailing space)
			// The space at position 12 should stay on the first line
			const chunks = wordWrapLine("hello world test", 12);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("hello world ");
			expect(chunks[1]!.text).toBe("test");
		});

		it("handles unbreakable word filling width exactly followed by space", () => {
			const chunks = wordWrapLine("aaaaaaaaaaaa aaaa", 12);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("aaaaaaaaaaaa");
			expect(chunks[1]!.text).toBe(" aaaa");
		});

		it("wraps word to next line when it fits width but not remaining space", () => {
			const chunks = wordWrapLine("      aaaaaaaaaaaa", 12);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("      ");
			expect(chunks[1]!.text).toBe("aaaaaaaaaaaa");
		});

		it("keeps word with multi-space and following word together when they fit", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,    consectetur", 30);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,    consectetur");
		});

		it("keeps word with multi-space and following word when they fill width exactly", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,              consectetur", 30);

			expect(chunks.length).toBe(2);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,              consectetur");
		});

		it("splits when word plus multi-space plus word exceeds width", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,               consectetur", 30);

			expect(chunks.length).toBe(3);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,               ");
			expect(chunks[2]!.text).toBe("consectetur");
		});

		it("breaks long whitespace at line boundary", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                         consectetur", 30);

			expect(chunks.length).toBe(3);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,                         ");
			expect(chunks[2]!.text).toBe("consectetur");
		});

		it("breaks long whitespace at line boundary 2", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                          consectetur", 30);

			expect(chunks.length).toBe(3);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,                         ");
			expect(chunks[2]!.text).toBe(" consectetur");
		});

		it("breaks whitespace spanning full lines", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                                     consectetur", 30);

			expect(chunks.length).toBe(3);
			expect(chunks[0]!.text).toBe("Lorem ipsum dolor sit ");
			expect(chunks[1]!.text).toBe("amet,                         ");
			expect(chunks[2]!.text).toBe("            consectetur");
		});

		it("force-breaks when wide char after word boundary wrap still overflows", () => {
			// " " (1) + "a"*186 (186) + "你" (2) = 189 visible width
			// maxWidth = 187: backtracking to the space would leave 186 + 2 = 188 > 187,
			// so the algorithm must force-break before the wide char instead.
			const line = ` ${"a".repeat(186)}你`;
			const chunks = wordWrapLine(line, 187);

			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 187, `chunk "${chunk.text.slice(0, 20)}..." has visible width ${visibleWidth(chunk.text)}, expected <= 187`).toBeTruthy();
			}
			// Verify no content is lost
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});

		it("splits oversized atomic segment across multiple chunks", () => {
			// Simulate a paste marker wider than maxWidth by passing pre-segmented data
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `A${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
				{ segment: "B", index: 1 + marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			// Every chunk must fit within maxWidth
			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 10, `chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`).toBeTruthy();
			}

			// Verify no content is lost
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});

		it("splits oversized atomic segment at start of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: "B", index: marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 10).toBeTruthy();
			}
			// "B" ends up on the last line (either alone or with the marker tail)
			expect(chunks[chunks.length - 1]!.text.includes("B")).toBe(true);

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});

		it("splits oversized atomic segment at end of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `A${marker}`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 10).toBeTruthy();
			}
			expect(chunks[0]!.text).toBe("A");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});

		it("splits consecutive oversized atomic segments", () => {
			const m1 = "[paste #1 +20 lines]"; // 21 chars
			const m2 = "[paste #2 +30 lines]"; // 21 chars
			const line = `${m1}${m2}`;
			const segments: Intl.SegmentData[] = [
				{ segment: m1, index: 0, input: line },
				{ segment: m2, index: m1.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 10, `chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`).toBeTruthy();
			}

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});

		it("wraps normally after oversized atomic segment", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker} hello world`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: " ", index: marker.length, input: line },
				{ segment: "h", index: marker.length + 1, input: line },
				{ segment: "e", index: marker.length + 2, input: line },
				{ segment: "l", index: marker.length + 3, input: line },
				{ segment: "l", index: marker.length + 4, input: line },
				{ segment: "o", index: marker.length + 5, input: line },
				{ segment: " ", index: marker.length + 6, input: line },
				{ segment: "w", index: marker.length + 7, input: line },
				{ segment: "o", index: marker.length + 8, input: line },
				{ segment: "r", index: marker.length + 9, input: line },
				{ segment: "l", index: marker.length + 10, input: line },
				{ segment: "d", index: marker.length + 11, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			// All chunks must fit
			for (const chunk of chunks) {
				expect(visibleWidth(chunk.text) <= 10, `chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`).toBeTruthy();
			}

			// Last chunk should contain "world" (normal wrapping resumes)
			expect(chunks[chunks.length - 1]!.text).toBe("world");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			expect(reconstructed).toBe(line);
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			expect(editor.getText()).toBe("foo bar ");

			// Move to beginning and yank
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("bazfoo bar ");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// Move cursor to middle
			editor.handleInput("\x01"); // Ctrl+A (start)
			editor.handleInput("\x1b[C"); // Right 5 times
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C"); // After "hello "

			editor.handleInput("\x15"); // Ctrl+U - deletes "hello "
			expect(editor.getText()).toBe("world");

			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A (start)
			editor.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			expect(editor.getText()).toBe("");

			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create kill ring with multiple entries
			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W - deletes "first"
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W - deletes "second"
			editor.setText("third");
			editor.handleInput("\x17"); // Ctrl+W - deletes "third"

			// Kill ring now has: [first, second, third]
			expect(editor.getText()).toBe("");

			editor.handleInput("\x19"); // Ctrl+Y - yanks "third" (most recent)
			expect(editor.getText()).toBe("third");

			editor.handleInput("\x1by"); // Alt+Y - cycles to "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1by"); // Alt+Y - cycles to "first"
			expect(editor.getText()).toBe("first");

			editor.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			expect(editor.getText()).toBe("third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x17"); // Ctrl+W - deletes "test"
			editor.setText("other");

			// Type something to break the yank chain
			editor.handleInput("x");
			expect(editor.getText()).toBe("otherx");

			// Alt+Y should do nothing
			editor.handleInput("\x1by"); // Alt+Y
			expect(editor.getText()).toBe("otherx");
		});

		it("Alt+Y does nothing if kill ring has ≤1 entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("only");
			editor.handleInput("\x17"); // Ctrl+W - deletes "only"

			editor.handleInput("\x19"); // Ctrl+Y - yanks "only"
			expect(editor.getText()).toBe("only");

			editor.handleInput("\x1by"); // Alt+Y - should do nothing (only 1 entry)
			expect(editor.getText()).toBe("only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("one two three");
			editor.handleInput("\x17"); // Ctrl+W - deletes "three"
			editor.handleInput("\x17"); // Ctrl+W - deletes "two " (prepended)
			editor.handleInput("\x17"); // Ctrl+W - deletes "one " (prepended)

			expect(editor.getText()).toBe("");

			// Should be one combined entry
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("one two three");
		});

		it("Ctrl+U accumulates multiline deletes including newlines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Start with multiline text, cursor at end
			editor.setText("line1\nline2\nline3");
			// Cursor is at end of line3 (line 2, col 5)

			// Delete "line3"
			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("line1\nline2\n");

			// Delete newline (at start of empty line 2, merges with line1)
			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("line1\nline2");

			// Delete "line2"
			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("line1\n");

			// Delete newline
			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("line1");

			// Delete "line1"
			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("");

			// All deletions accumulated into one entry: "line1\nline2\nline3"
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("line1\nline2\nline3");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("prefix|suffix");
			// Position cursor at |
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x0b"); // Ctrl+K - deletes "suffix" (forward)
			editor.handleInput("\x0b"); // Ctrl+K - deletes "|" (forward, appended)
			expect(editor.getText()).toBe("prefix");

			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("prefix|suffix");
		});

		it("non-delete actions break kill accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Delete "baz", then type "x" to break accumulation, then delete "x"
			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			expect(editor.getText()).toBe("foo bar ");

			editor.handleInput("x"); // Typing breaks accumulation
			expect(editor.getText()).toBe("foo bar x");

			editor.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry, not accumulated)
			expect(editor.getText()).toBe("foo bar ");

			// Yank most recent - should be "x", not "xbaz"
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("foo bar x");

			// Cycle to previous - should be "baz" (separate entry)
			editor.handleInput("\x1by"); // Alt+Y
			expect(editor.getText()).toBe("foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("");

			editor.handleInput("\x19"); // Ctrl+Y - yanks "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("x"); // Type breaks yank chain
			expect(editor.getText()).toBe("secondx");

			editor.handleInput("\x1by"); // Alt+Y - should do nothing
			expect(editor.getText()).toBe("secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // deletes "first"
			editor.setText("second");
			editor.handleInput("\x17"); // deletes "second"
			editor.setText("third");
			editor.handleInput("\x17"); // deletes "third"
			editor.setText("");

			// Ring: [first, second, third]

			editor.handleInput("\x19"); // Ctrl+Y - yanks "third"
			editor.handleInput("\x1by"); // Alt+Y - cycles to "second", ring rotates

			// Now ring is: [third, first, second]
			expect(editor.getText()).toBe("second");

			// Do something else
			editor.handleInput("x");
			editor.setText("");

			// New yank should get "second" (now at end after rotation)
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("second");
		});

		it("consecutive deletions across lines coalesce into one entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "1\n2\n3" with cursor at end, delete everything with Ctrl+W
			editor.setText("1\n2\n3");
			editor.handleInput("\x17"); // Ctrl+W - deletes "3"
			expect(editor.getText()).toBe("1\n2\n");

			editor.handleInput("\x17"); // Ctrl+W - deletes newline (merge with prev line)
			expect(editor.getText()).toBe("1\n2");

			editor.handleInput("\x17"); // Ctrl+W - deletes "2"
			expect(editor.getText()).toBe("1\n");

			editor.handleInput("\x17"); // Ctrl+W - deletes newline
			expect(editor.getText()).toBe("1");

			editor.handleInput("\x17"); // Ctrl+W - deletes "1"
			expect(editor.getText()).toBe("");

			// All deletions should have accumulated into one entry
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("1\n2\n3");
		});

		it("Ctrl+K at line end deletes newline and coalesces", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "ab" on line 1, "cd" on line 2, cursor at end of line 1
			editor.setText("");
			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\n");
			editor.handleInput("c");
			editor.handleInput("d");
			// Move to end of first line
			editor.handleInput("\x1b[A"); // Up arrow
			editor.handleInput("\x05"); // Ctrl+E - end of line

			// Now at end of "ab", Ctrl+K should delete newline (merge with "cd")
			editor.handleInput("\x0b"); // Ctrl+K - deletes newline
			expect(editor.getText()).toBe("abcd");

			// Continue deleting
			editor.handleInput("\x0b"); // Ctrl+K - deletes "cd"
			expect(editor.getText()).toBe("ab");

			// Both deletions should accumulate
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("ab\ncd");
		});

		it("handles yank in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("word");
			editor.handleInput("\x17"); // Ctrl+W - deletes "word"
			editor.setText("hello world");

			// Move to middle (after "hello ")
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create two kill ring entries
			editor.setText("FIRST");
			editor.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			editor.setText("SECOND");
			editor.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			// Ring: ["FIRST", "SECOND"]

			// Set up "hello world" and position cursor after "hello "
			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6

			// Yank "SECOND" in the middle
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello SECONDworld");

			// Yank-pop replaces "SECOND" with "FIRST"
			editor.handleInput("\x1by"); // Alt+Y
			expect(editor.getText()).toBe("hello FIRSTworld");
		});

		it("multiline yank and yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create single-line entry
			editor.setText("SINGLE");
			editor.handleInput("\x17"); // Ctrl+W - deletes "SINGLE"

			// Create multiline entry via consecutive Ctrl+U
			editor.setText("A\nB");
			editor.handleInput("\x15"); // Ctrl+U - deletes "B"
			editor.handleInput("\x15"); // Ctrl+U - deletes newline
			editor.handleInput("\x15"); // Ctrl+U - deletes "A"
			// Ring: ["SINGLE", "A\nB"]

			// Insert in middle of "hello world"
			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			// Yank multiline "A\nB"
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello A\nBworld");

			// Yank-pop replaces with "SINGLE"
			editor.handleInput("\x1by"); // Alt+Y
			expect(editor.getText()).toBe("hello SINGLEworld");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world test");
			editor.handleInput("\x01"); // Ctrl+A - go to start

			editor.handleInput("\x1bd"); // Alt+D - deletes "hello"
			expect(editor.getText()).toBe(" world test");

			editor.handleInput("\x1bd"); // Alt+D - deletes " world" (skips whitespace, then word)
			expect(editor.getText()).toBe(" test");

			// Yank should get accumulated text
			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("hello world test");
		});

		it("Alt+D at end of line deletes newline", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("line1\nline2");
			// Move to start of document, then to end of first line
			editor.handleInput("\x1b[A"); // Up arrow - go to first line
			editor.handleInput("\x05"); // Ctrl+E - end of line

			editor.handleInput("\x1bd"); // Alt+D - deletes newline (merges lines)
			expect(editor.getText()).toBe("line1line2");

			editor.handleInput("\x19"); // Ctrl+Y
			expect(editor.getText()).toBe("line1\nline2");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("hello world");

			// Undo removes " world" (space captured state before it, so we restore to "hello")
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello");

			// Undo removes "hello"
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");
		});

		it("undoes spaces one at a time", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput(" ");
			expect(editor.getText()).toBe("hello  ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			expect(editor.getText()).toBe("hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			expect(editor.getText()).toBe("hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			expect(editor.getText()).toBe("");
		});

		it("undoes newlines and signals next word to capture state", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\n");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("hello\nworld");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello\n");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");
		});

		it("undoes backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x7f"); // Backspace
			expect(editor.getText()).toBe("hell");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello");
		});

		it("undoes forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			editor.handleInput("\x1b[C"); // Right arrow
			editor.handleInput("\x1b[3~"); // Delete key
			expect(editor.getText()).toBe("hllo");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("\x17"); // Ctrl+W
			expect(editor.getText()).toBe("hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x0b"); // Ctrl+K
			expect(editor.getText()).toBe("hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("|");
			expect(editor.getText()).toBe("hello |world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x15"); // Ctrl+U
			expect(editor.getText()).toBe("world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");
		});

		it("undoes yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("\x17"); // Ctrl+W - delete "hello "
			editor.handleInput("\x19"); // Ctrl+Y - yank
			expect(editor.getText()).toBe("hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");
		});

		it("undoes single-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Simulate bracketed paste of "beep boop"
			editor.handleInput("\x1b[200~beep boop\x1b[201~");
			expect(editor.getText()).toBe("hellobeep boop world");

			// Single undo should restore entire pre-paste state
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("|");
			expect(editor.getText()).toBe("hello| world");
		});

		it("does not trigger autocomplete during single-line paste", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async () => {
					suggestionCalls += 1;
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);
			editor.handleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~");

			expect(editor.getText()).toBe("look at @node_modules/react/index.js please");
			expect(suggestionCalls).toBe(0);
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("decodes CSI-u Ctrl+letter sequences inside bracketed paste (tmux popup)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// tmux popups with extended-keys-format=csi-u re-encode \n in pastes as
			// \x1b[106;5u (Ctrl+J). Without decoding, the per-char filter strips ESC
			// and leaks "[106;5u" between lines. See issue #3599.
			editor.handleInput("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~");
			expect(editor.getText()).toBe("line1\nline2\nline3");
		});

		it("undoes multi-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Simulate bracketed paste of multi-line text
			editor.handleInput("\x1b[200~line1\nline2\nline3\x1b[201~");
			expect(editor.getText()).toBe("helloline1\nline2\nline3 world");

			// Single undo should restore entire pre-paste state
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("|");
			expect(editor.getText()).toBe("hello| world");
		});

		it("undoes insertTextAtCursor atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Programmatic insertion (e.g., clipboard image path)
			editor.insertTextAtCursor("/tmp/image.png");
			expect(editor.getText()).toBe("hello/tmp/image.png world");

			// Single undo should restore entire pre-insert state
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("|");
			expect(editor.getText()).toBe("hello| world");
		});

		it("insertTextAtCursor handles multiline text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Insert multiline text
			editor.insertTextAtCursor("line1\nline2\nline3");
			expect(editor.getText()).toBe("helloline1\nline2\nline3 world");

			// Cursor should be at end of inserted text (after "line3", before " world")
			const cursor = editor.getCursor();
			expect(cursor.line).toBe(2);
			expect(cursor.col).toBe(5); // "line3".length

			// Single undo should restore entire pre-insert state
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");
		});

		it("insertTextAtCursor normalizes CRLF and CR line endings", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");

			// Insert text with CRLF
			editor.insertTextAtCursor("a\r\nb\r\nc");
			expect(editor.getText()).toBe("a\nb\nc");

			editor.handleInput("\x1b[45;5u"); // Undo
			expect(editor.getText()).toBe("");

			// Insert text with CR only
			editor.insertTextAtCursor("x\ry\rz");
			expect(editor.getText()).toBe("x\ny\nz");
		});

		it("undoes setText to empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("hello world");

			editor.setText("");
			expect(editor.getText()).toBe("");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");
		});

		it("clears undo stack on submit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\r"); // Enter - submit

			expect(submitted).toBe("hello");
			expect(editor.getText()).toBe("");

			// Undo should do nothing - stack was cleared
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");
		});

		it("exits history browsing mode on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add "hello" to history
			editor.addToHistory("hello");
			expect(editor.getText()).toBe("");

			// Type "world"
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("world");

			// Ctrl+W - delete word
			editor.handleInput("\x17"); // Ctrl+W
			expect(editor.getText()).toBe("");

			// Press Up - enter history browsing, shows "hello"
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getText()).toBe("hello");

			// Undo should restore to "" (state before entering history browsing)
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");

			// Undo again should restore to "world" (state before Ctrl+W)
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("world");
		});

		it("undo restores to pre-history state even after multiple history navigations", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add history entries
			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			// Type something
			editor.handleInput("c");
			editor.handleInput("u");
			editor.handleInput("r");
			editor.handleInput("r");
			editor.handleInput("e");
			editor.handleInput("n");
			editor.handleInput("t");
			expect(editor.getText()).toBe("current");

			// Clear editor
			editor.handleInput("\x17"); // Ctrl+W
			expect(editor.getText()).toBe("");

			// Navigate through history multiple times
			editor.handleInput("\x1b[A"); // Up - "third"
			expect(editor.getText()).toBe("third");
			editor.handleInput("\x1b[A"); // Up - "second"
			expect(editor.getText()).toBe("second");
			editor.handleInput("\x1b[A"); // Up - "first"
			expect(editor.getText()).toBe("first");

			// Undo should go back to "" (state before we started browsing), not intermediate states
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("");

			// Another undo goes back to "current"
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("current");
		});

		it("cursor movement starts new undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("hello world");

			// Move cursor left 5 (to after "hello ")
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[D");

			// Type "lol" in the middle
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("l");
			expect(editor.getText()).toBe("hello lolworld");

			// Undo should restore to "hello world" (before inserting "lol")
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello world");

			editor.handleInput("|");
			expect(editor.getText()).toBe("hello |world");
		});

		it("no-op delete operations do not push undo snapshots", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			expect(editor.getText()).toBe("hello");

			// Delete word on empty - multiple times (should be no-ops)
			editor.handleInput("\x17"); // Ctrl+W - deletes "hello"
			expect(editor.getText()).toBe("");
			editor.handleInput("\x17"); // Ctrl+W - no-op (nothing to delete)
			editor.handleInput("\x17"); // Ctrl+W - no-op

			// Single undo should restore "hello"
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("hello");
		});

		it("undoes autocomplete", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create a mock autocomplete provider
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "di") {
						return {
							items: [{ value: "dist/", label: "dist/" }],
							prefix: "di",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "di"
			editor.handleInput("d");
			editor.handleInput("i");
			expect(editor.getText()).toBe("di");

			// Press Tab to trigger autocomplete
			editor.handleInput("\t");
			await flushAutocomplete();
			expect(editor.getText()).toBe("dist/");
			expect(editor.isShowingAutocomplete()).toBe(false);

			// Undo should restore to "di"
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("di");
		});
	});

	describe("Undo memory bounds", () => {
		/** 12-line paste content with a distinguishing tag */
		function bigPaste(tag: string): string {
			return Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n");
		}

		function pastePayload(editor: Editor, payload: string): void {
			editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
		}

		it("bounds undo snapshot memory for large pastes", () => {
			const payload = `${"x".repeat(2_000_000)}\n${"y".repeat(200_000)}\n${"z".repeat(200_000)}`;
			const heapAfter = (undoSteps: number, paste: boolean): number => {
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				(globalThis as { gc?: () => void }).gc?.();
				const before = process.memoryUsage().heapUsed;

				if (paste) pastePayload(editor, payload);
				for (let i = 0; i < undoSteps; i++) {
					editor.handleInput("w");
					editor.handleInput(" ");
				}

				(globalThis as { gc?: () => void }).gc?.();
				return process.memoryUsage().heapUsed - before;
			};

			// Same 120 undo units with and without the paste: retention must not
			// grow with the payload, and the paste-free run subtracts the noise a
			// running test suite leaves in the heap. Measured on both runtimes,
			// copying the registry grows this figure by 265 MB or more, while a
			// shared registry stays within the drift of the noise floor.
			const growth = heapAfter(120, true) - heapAfter(120, false);
			expect(growth < 100 * 1024 * 1024, `undo snapshots must not copy the paste payload per step (grew ${Math.round(growth / 1024 / 1024)} MB)`).toBeTruthy();
		});

		it("restores the paste registry and expands the payload after undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const payload = bigPaste("payload");
			pastePayload(editor, payload);
			const marker = editor.getText();
			expect(String(marker)).toMatch(/\[paste #1 \+12 lines\]/);
			expect(editor.getExpandedText().includes("payload11")).toBeTruthy();

			editor.handleInput("tail");
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe(marker);
			expect(editor.getExpandedText().includes("payload11"), "the undone snapshot still expands its payload").toBeTruthy();
		});

		it("caps undo stack depth", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { undoDepth: 200 });
			const stack = editor as unknown as { getUndoDepth(): number };

			for (let i = 0; i < 1000; i++) {
				editor.handleInput("x");
				editor.handleInput(" ");
			}

			expect(stack.getUndoDepth() <= 200, `depth capped (got ${stack.getUndoDepth()})`).toBeTruthy();
		});
	});

	describe("Autocomplete", () => {
		it("auto-applies single force-file suggestion without showing menu", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "Work") {
						return {
							items: [{ value: "Workspace/", label: "Workspace/" }],
							prefix: "Work",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "Work"
			editor.handleInput("W");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("k");
			expect(editor.getText()).toBe("Work");

			// Press Tab - should auto-apply without showing menu
			editor.handleInput("\t");
			await flushAutocomplete();
			expect(editor.getText()).toBe("Workspace/");
			expect(editor.isShowingAutocomplete()).toBe(false);

			// Undo should restore to "Work"
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("Work");
		});

		it("shows menu when force-file has multiple suggestions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "src") {
						return {
							items: [
								{ value: "src/", label: "src/" },
								{ value: "src.txt", label: "src.txt" },
							],
							prefix: "src",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "src"
			editor.handleInput("s");
			editor.handleInput("r");
			editor.handleInput("c");
			expect(editor.getText()).toBe("src");

			// Press Tab - should show menu because there are multiple suggestions
			editor.handleInput("\t");
			await flushAutocomplete();
			expect(editor.getText()).toBe("src");
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Tab again to accept first suggestion
			editor.handleInput("\t");
			expect(editor.getText()).toBe("src/");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("keeps suggestions open when typing in force mode (Tab-triggered)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const allFiles = [
				{ value: "readme.md", label: "readme.md" },
				{ value: "package.json", label: "package.json" },
				{ value: "src/", label: "src/" },
				{ value: "dist/", label: "dist/" },
			];

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					const shouldMatch = options.force || prefix.includes("/") || prefix.startsWith(".");
					if (!shouldMatch) {
						return null;
					}
					const filtered = allFiles.filter((f) => f.value.toLowerCase().startsWith(prefix.toLowerCase()));
					if (filtered.length > 0) {
						return { items: filtered, prefix };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Press Tab on empty prompt - should show all files (force mode)
			editor.handleInput("\t");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Type "r" - should narrow to "readme.md" (force mode keeps suggestions open)
			editor.handleInput("r");
			await flushAutocomplete();
			expect(editor.getText()).toBe("r");
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Type "e" - should still show "readme.md"
			editor.handleInput("e");
			await flushAutocomplete();
			expect(editor.getText()).toBe("re");
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Accept with Tab
			editor.handleInput("\t");
			expect(editor.getText()).toBe("readme.md");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("debounces @ autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "@main.ts", label: "main.ts" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");

			expect(suggestionCalls).toBe(0);
			expect(editor.isShowingAutocomplete()).toBe(false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			expect(suggestionCalls).toBe(1);
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("re-queries the autocomplete picker when the cursor moves back into the command name", async () => {
			// Regression for earendil-works/pi#5496: arrowing left out of a slash
			// command's argument region must re-query the picker, not leave the
			// stale argument list showing. Before the fix, moveCursor() never
			// called updateAutocomplete(), so `/cmd ` (argument menu) + Left kept
			// displaying the arguments against a `/cmd` prefix — and a Tab there
			// would concatenate the stale suggestion onto the partial command name.
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const before = (lines[0] || "").slice(0, cursorCol);
					if (!before.startsWith("/")) return null;
					// Past the command name (a space before the cursor): offer arguments.
					if (before.includes(" ")) {
						return {
							items: [
								{ value: "repo", label: "repo" },
								{ value: "message", label: "message" },
								{ value: "help", label: "help" },
							],
							prefix: before.slice(before.indexOf(" ") + 1),
						};
					}
					// Inside the command name: offer the command name only.
					return { items: [{ value: "cmd", label: "cmd" }], prefix: before };
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type `/cmd ` so the picker ends up showing the argument list.
			for (const ch of "/cmd ") {
				editor.handleInput(ch);
				await flushAutocomplete();
			}
			expect(editor.getText()).toBe("/cmd ");
			expect(editor.isShowingAutocomplete()).toBe(true);
			const atArg = editor
				.render(80)
				.map((l) => stripVTControlCharacters(l))
				.join("\n");
			expect(atArg.includes("repo"), "argument menu should be visible at `/cmd `").toBeTruthy();

			// Arrow Left back into the command name (`/cmd`).
			editor.handleInput("\x1b[D");
			await flushAutocomplete();

			// The picker must have re-queried: the stale argument items are gone
			// (replaced by the command-name suggestion, or the picker closed).
			const afterMove = editor
				.render(80)
				.map((l) => stripVTControlCharacters(l))
				.join("\n");
			expect(!afterMove.includes("repo"), "stale argument menu must not survive the cursor move").toBeTruthy();
			expect(!afterMove.includes("message"), "stale argument menu must not survive the cursor move").toBeTruthy();
		});

		it("debounces # autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "#2983", label: "#2983" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("#");
			editor.handleInput("2");
			editor.handleInput("9");
			editor.handleInput("8");

			expect(suggestionCalls).toBe(0);
			expect(editor.isShowingAutocomplete()).toBe(false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			expect(suggestionCalls).toBe(1);
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("debounces custom triggerCharacters autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			editor.setAutocompleteProvider({
				triggerCharacters: ["$"],
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const prefix = (lines[0] || "").slice(0, cursorCol);
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix };
				},
				applyCompletion,
			});

			editor.handleInput("$");
			editor.handleInput("s");
			editor.handleInput("k");

			expect(suggestionCalls).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			expect(suggestionCalls).toBe(1);
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("resets custom triggerCharacters when provider changes", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			editor.setAutocompleteProvider({
				triggerCharacters: ["$"],
				getSuggestions: async () => ({ items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" }),
				applyCompletion,
			});
			editor.setAutocompleteProvider({
				getSuggestions: async () => {
					suggestionCalls += 1;
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" };
				},
				applyCompletion,
			});

			editor.handleInput("$");
			editor.handleInput("s");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			expect(suggestionCalls).toBe(0);
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("aborts active @ autocomplete when typing continues", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let aborts = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
					return await new Promise((resolve) => {
						const timeout = setTimeout(() => {
							resolve({ items: [{ value: "@main.ts", label: "main.ts" }], prefix: "@main" });
						}, 500);
						options.signal.addEventListener(
							"abort",
							() => {
								aborts += 1;
								clearTimeout(timeout);
								resolve(null);
							},
							{ once: true },
						);
					});
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");
			await new Promise((resolve) => setTimeout(resolve, 250));
			editor.handleInput("n");
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(aborts).toBe(1);
		});

		it("keeps autocomplete alive after a provider rejection and reports it once", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;
			let reportCalls = 0;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);

			try {
				const failure = new Error("provider exploded");
				const mockProvider: AutocompleteProvider = {
					getSuggestions: async () => {
						suggestionCalls += 1;
						throw failure;
					},
					applyCompletion,
				};
				editor.setAutocompleteProvider(mockProvider);
				editor.onAutocompleteError = () => {
					reportCalls += 1;
				};

				editor.handleInput("@");
				editor.handleInput("m");
				await new Promise((resolve) => setTimeout(resolve, 50));
				await flushAutocomplete();
				await new Promise((resolve) => setTimeout(resolve, 20));

				expect(reportCalls, "a provider error is reported once").toBe(1);
				expect(unhandled.length, "no unhandled rejection escapes").toBe(0);
				expect(editor.isShowingAutocomplete(), "no stale suggestions").toBe(false);

				// The request chain must survive: the next keystroke still queries.
				editor.handleInput("a");
				await new Promise((resolve) => setTimeout(resolve, 50));
				await flushAutocomplete();
				await new Promise((resolve) => setTimeout(resolve, 20));

				expect(suggestionCalls >= 2, `provider re-queried (calls=${suggestionCalls})`).toBeTruthy();
				expect(reportCalls, "the same failure is not reported again").toBe(1);
				expect(unhandled.length, "no unhandled rejection escapes").toBe(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("stays silent when the provider rejects with an abort", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;
			let reportCalls = 0;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);

			try {
				const abortError = new DOMException("Aborted", "AbortError");
				const mockProvider: AutocompleteProvider = {
					getSuggestions: async () => {
						suggestionCalls += 1;
						throw abortError;
					},
					applyCompletion,
				};
				editor.setAutocompleteProvider(mockProvider);
				editor.onAutocompleteError = () => {
					reportCalls += 1;
				};

				editor.handleInput("@");
				editor.handleInput("m");
				await new Promise((resolve) => setTimeout(resolve, 50));
				await flushAutocomplete();
				await new Promise((resolve) => setTimeout(resolve, 20));

				expect(reportCalls, "aborts are the expected cancellation path").toBe(0);
				expect(unhandled.length, "no unhandled rejection escapes").toBe(0);

				editor.handleInput("a");
				await new Promise((resolve) => setTimeout(resolve, 50));
				await flushAutocomplete();
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(suggestionCalls >= 2, `provider re-queried (calls=${suggestionCalls})`).toBeTruthy();
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("hides autocomplete when backspacing slash command to empty", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider with slash commands
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					// Only return slash command suggestions when line starts with /
					if (prefix.startsWith("/")) {
						const commands = [
							{ value: "/model", label: "model", description: "Change model" },
							{ value: "/help", label: "help", description: "Show help" },
						];
						const query = prefix.slice(1); // Remove leading /
						const filtered = commands.filter((c) => c.value.startsWith(query));
						if (filtered.length > 0) {
							return { items: filtered, prefix };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/" - should show slash command suggestions
			editor.handleInput("/");
			await flushAutocomplete();
			expect(editor.getText()).toBe("/");
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Backspace to delete "/" - should hide autocomplete completely
			editor.handleInput("\x7f"); // Backspace
			await flushAutocomplete();
			expect(editor.getText()).toBe("");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("applies exact typed slash-argument value on Enter even when first item is highlighted", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /argtest command with argument completions
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in argument completion context: "/argtest <prefix>"
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						// Return all arguments that start with the typed prefix
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest two"
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");
			editor.handleInput("o");

			expect(editor.getText()).toBe("/argtest two");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Enter - should apply the exact typed value "two", not the first item
			editor.handleInput("\r");

			// The exact typed value "two" should be retained
			expect(editor.getText()).toBe("/argtest two");
		});

		it("selects first prefix match on Enter when typed arg is not exact match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /argtest command with argument completions
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in argument completion context
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
							{ value: "twelve", label: "twelve" },
						];
						// Return all items that start with the typed prefix
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest t" - filtered to [two, three, twelve], prefix "t" matches "two" first
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Enter - "t" prefix matches "two" (first in list), so "two" is applied
			editor.handleInput("\r");
			expect(editor.getText()).toBe("/argtest two");
		});

		it("highlights unique prefix match as user types (before full exact match)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider that returns all items unfiltered (like real extensions do)
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						// Return all items - provider does not filter
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest tw" - "tw" is a prefix of only "two"
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");

			expect(editor.getText()).toBe("/argtest tw");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Enter - "tw" uniquely matches "two", so "two" should be applied
			editor.handleInput("\r");
			expect(editor.getText()).toBe("/argtest two");
		});

		it("selects first prefix match when multiple items match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider that returns all items unfiltered
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest t" - "t" is a prefix of both "two" and "three"
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Enter - "t" matches "two" first, so "two" is selected
			editor.handleInput("\r");
			expect(editor.getText()).toBe("/argtest two");
		});

		it("works for built-in-style command argument completion path (model-like)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /model command with model completions
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in /model argument completion context
					// Use [^ ]+ to match any non-space characters (including hyphens)
					const modelMatch = beforeCursor.match(/^\/model\s+(\S+)$/);
					if (modelMatch) {
						const modelText = modelMatch[1]!;
						const allModels = [
							{ value: "gpt-4o", label: "gpt-4o" },
							{ value: "gpt-4o-mini", label: "gpt-4o-mini" },
							{ value: "claude-sonnet", label: "claude-sonnet" },
						];
						// Return all models that start with the typed prefix
						const filtered = allModels.filter((m) => m.value.startsWith(modelText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: modelText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// Type "/model gpt-4o-mini" - exact match for second item in list
			editor.handleInput("/");
			editor.handleInput("m");
			editor.handleInput("o");
			editor.handleInput("d");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput(" ");
			editor.handleInput("g");
			editor.handleInput("p");
			editor.handleInput("t");
			editor.handleInput("-");
			editor.handleInput("4");
			editor.handleInput("o");
			editor.handleInput("-");
			editor.handleInput("m");
			editor.handleInput("i");
			editor.handleInput("n");
			editor.handleInput("i");

			expect(editor.getText()).toBe("/model gpt-4o-mini");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Enter - should retain exact typed value, not apply first highlighted item
			editor.handleInput("\r");

			// The exact typed value should be retained
			expect(editor.getText()).toBe("/model gpt-4o-mini");
		});

		it("awaits async slash command argument completions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: async (prefix) =>
							prefix.startsWith("s") ? [{ value: "skill-a", label: "skill-a" }] : null,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput("\t");
			expect(editor.getText()).toBe("/load-skills skill-a");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("ignores invalid slash command argument completion results", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: (() => "not-an-array") as unknown as (
							argumentPrefix: string,
						) => Promise<{ value: string; label: string }[] | null>,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(false);
			expect(editor.getText()).toBe("/load-skills s");
		});

		it("does not show argument completions when command has no argument completer", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show help" },
					{
						name: "model",
						description: "Switch model",
						getArgumentCompletions: () => [{ value: "claude-opus", label: "claude-opus" }],
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput("\t");
			expect(editor.getText()).toBe("/help ");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});
	});

	describe("Inline slash trigger", () => {
		const inlineProvider: AutocompleteProvider = {
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
				if (!beforeCursor.endsWith("/")) return null;
				return {
					items: [{ value: "skill:review", label: "skill:review" }],
					prefix: "/",
				};
			},
			applyCompletion,
		};

		it("does not trigger for `/` after whitespace mid-input by default", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setAutocompleteProvider(inlineProvider);

			for (const ch of "hello ") editor.handleInput(ch);
			editor.handleInput("/");
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("triggers for `/` after whitespace mid-input when inlineSlashTrigger is on", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			editor.setAutocompleteProvider(inlineProvider);

			for (const ch of "hello ") editor.handleInput(ch);
			editor.handleInput("/");
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("retriggers inline completion as token characters arrive with the slash's request in flight", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			editor.setAutocompleteProvider({
				getSuggestions: async (lines, cursorLine, cursorCol) => {
					const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
					const match = /\/skill:\w*$/.exec(beforeCursor);
					if (match === null) return null;
					return {
						items: [{ value: "skill:review", label: "skill:review" }],
						prefix: match[0],
					};
				},
				applyCompletion,
			});

			// The slash and its first letters land back-to-back, the way one
			// stdin chunk delivers them: the slash's request is still in flight
			// while the letters arrive with no autocomplete state yet.
			for (const ch of "hello /skill:r") editor.handleInput(ch);
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("retriggers inline completion on later lines as the token grows", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			editor.setAutocompleteProvider({
				getSuggestions: async (lines, cursorLine, cursorCol) => {
					const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
					const match = /\/skill:\w*$/.exec(beforeCursor);
					if (match === null) return null;
					return {
						items: [{ value: "skill:review", label: "skill:review" }],
						prefix: match[0],
					};
				},
				applyCompletion,
			});

			for (const ch of "hello\n/skill:r") editor.handleInput(ch);
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("retriggers inline completion when a colon follows the token name", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			let calls = 0;
			editor.setAutocompleteProvider({
				getSuggestions: async (lines, cursorLine, cursorCol) => {
					calls += 1;
					const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
					const match = /\/skill:\w*$/.exec(beforeCursor);
					if (match === null) return null;
					return {
						items: [{ value: "skill:review", label: "skill:review" }],
						prefix: match[0],
					};
				},
				applyCompletion,
			});

			for (const ch of "hello /skill") editor.handleInput(ch);
			await flushAutocomplete();
			const beforeColon = calls;
			editor.handleInput(":");
			await flushAutocomplete();
			expect(calls > beforeColon, "expected the colon to retrigger completion").toBeTruthy();
			editor.handleInput("r");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("triggers for `/` at the start of a later line when inlineSlashTrigger is on", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			editor.setAutocompleteProvider(inlineProvider);

			for (const ch of "first") editor.handleInput(ch);
			editor.handleInput("\n");
			editor.handleInput("/");
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("does not trigger for `/` inside a word even when inlineSlashTrigger is on", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			editor.setAutocompleteProvider(inlineProvider);

			for (const ch of "and/") editor.handleInput(ch);
			await flushAutocomplete();

			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		function inlineProviderWith(item: { value: string; label: string; data?: Record<string, unknown> }): AutocompleteProvider {
			return {
				getSuggestions: async (lines, cursorLine, cursorCol) => {
					const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
					if (!beforeCursor.endsWith("/")) return null;
					return { items: [item], prefix: "/" };
				},
				applyCompletion,
			};
		}

		it("does not submit when confirming an inline-marked completion with Enter", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			let submitted: string | undefined;
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.setAutocompleteProvider(
				inlineProviderWith({ value: "skill:review", label: "skill:review", data: { inlineSkill: true } }),
			);

			for (const ch of "hello ") editor.handleInput(ch);
			editor.handleInput("/");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput("\r");
			await flushAutocomplete();

			expect(submitted).toBe(undefined);
			expect(editor.getText()).toBe("hello skill:review");
		});

		it("still submits when confirming an unmarked slash completion with Enter", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { inlineSlashTrigger: true });
			let submitted: string | undefined;
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.setAutocompleteProvider(inlineProviderWith({ value: "help", label: "help" }));

			for (const ch of "hello ") editor.handleInput(ch);
			editor.handleInput("/");
			await flushAutocomplete();
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput("\r");
			await flushAutocomplete();

			expect(submitted).toBe("hello help");
		});
	});

	describe("Character jump (Ctrl+])", () => {
		it("jumps forward to first occurrence of character on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] (legacy sequence for ctrl+])
			editor.handleInput("o"); // Jump to first 'o'

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 }); // 'o' in "hello"
		});

		it("jumps forward to next occurrence after cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// Move cursor to the 'o' in "hello" (col 4)
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o"); // Jump to next 'o' (in "world")

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps forward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			// Cursor is at end (line 2, col 3). Move to line 0 via up arrows, then Ctrl+A
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - now on line 0
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("g"); // Jump to 'g' on line 3

			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 0 });
		});

		it("jumps backward to first occurrence before cursor on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// Cursor at end (col 11)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] (ESC followed by Ctrl+])
			editor.handleInput("o"); // Jump to last 'o' before cursor

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps backward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			// Cursor at end of line 3
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 3 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("a"); // Jump to 'a' on line 1

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});

		it("does nothing when character is not found (forward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("z"); // 'z' doesn't exist

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 }); // Cursor unchanged
		});

		it("does nothing when character is not found (backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// Cursor at end
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("z"); // 'z' doesn't exist

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 }); // Cursor unchanged
		});

		it("is case-sensitive", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("Hello World");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			// Search for lowercase 'h' - should not find it (only 'H' exists)
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("h");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 }); // Cursor unchanged

			// Search for uppercase 'W' - should find it
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("W");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 }); // 'W' in "World"
		});

		it("cancels jump mode when Ctrl+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1d"); // Ctrl+] again - cancel

			// Type 'o' normally - should insert, not jump
			editor.handleInput("o");
			expect(editor.getText()).toBe("ohello world");
		});

		it("cancels jump mode on Escape and processes the Escape", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1b"); // Escape - cancel jump mode

			// Cursor should be unchanged (Escape itself doesn't move cursor in editor)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			// Type 'o' normally - should insert, not jump
			editor.handleInput("o");
			expect(editor.getText()).toBe("ohello world");
		});

		it("cancels backward jump mode when Ctrl+Alt+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// Cursor at end
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] - enter backward jump mode
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] again - cancel

			// Type 'o' normally - should insert, not jump
			editor.handleInput("o");
			expect(editor.getText()).toBe("hello worldo");
		});

		it("searches for special characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo(bar) = baz;");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			// Jump to '('
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("(");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });

			// Jump to '='
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("=");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 9 });
		});

		it("handles empty text gracefully", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("x");

			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 }); // Cursor unchanged
		});

		it("resets lastAction when jumping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start

			// Type to set lastAction to "type-word"
			editor.handleInput("x");
			expect(editor.getText()).toBe("xhello world");

			// Jump forward
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o");

			// Type more - should start a new undo unit (lastAction was reset)
			editor.handleInput("Y");
			expect(editor.getText()).toBe("xhellYo world");

			// Undo should only undo "Y", not "x" as well
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("xhello world");
		});
	});

	describe("Sticky column", () => {
		// Helper: position cursor at a specific line and column
		function positionCursor(editor: Editor, line: number, col: number): void {
			// Go to line 0 first
			for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
			// Go to target line
			for (let i = 0; i < line; i++) editor.handleInput("\x1b[B");
			// Go to target col
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < col; i++) editor.handleInput("\x1b[C");
		}

		it("preserves target column when moving up through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: "2222222222x222" (x at col 10)
			// Line 1: "" (empty)
			// Line 2: "1111111111_111111111111" (_ at col 10)
			editor.setText("2222222222x222\n\n1111111111_111111111111");

			// Position cursor on _ (line 2, col 10)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 23 }); // At end
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Move right to col 10
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 10 });

			// Press Up - should move to empty line (col clamped to 0)
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			// Press Up again - should move to line 0 at col 10 (on 'x')
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });
		});

		it("preserves target column when moving down through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1111111111_111\n\n2222222222x222222222222");

			// Position cursor on _ (line 0, col 10)
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });

			// Press Down - should move to empty line (col clamped to 0)
			editor.handleInput("\x1b[B"); // Down arrow
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			// Press Down again - should move to line 2 at col 10 (on 'x')
			editor.handleInput("\x1b[B"); // Down arrow
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 10 });
		});

		it("resets sticky column on horizontal movement (left arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 5
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 5 });

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (sticky)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 });

			// Move left - resets sticky column
			editor.handleInput("\x1b[D"); // Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 4 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 4 (new sticky from col 4)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 4 });
		});

		it("resets sticky column on horizontal movement (right arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 0, col 5
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 });

			// Move down through empty line
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (sticky)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 5 });

			// Move right - resets sticky column
			editor.handleInput("\x1b[C"); // Right
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 6 });

			// Move up twice
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 6 (new sticky from col 6)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 });
		});

		it("resets sticky column on typing", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });

			// Type a character - resets sticky column
			editor.handleInput("X");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 9 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 9 (new sticky from col 9)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 9 });
		});

		it("resets sticky column on backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });

			// Backspace - resets sticky column
			editor.handleInput("\x7f"); // Backspace
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 7 (new sticky from col 7)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 7 });
		});

		it("resets sticky column on Ctrl+A (move to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up - establishes sticky col 8
			editor.handleInput("\x1b[A"); // Up - line 1, col 0

			// Ctrl+A - resets sticky column to 0
			editor.handleInput("\x01"); // Ctrl+A
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			// Move up
			editor.handleInput("\x1b[A"); // Up - line 0, col 0 (new sticky from col 0)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});

		it("resets sticky column on Ctrl+E (move to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("12345\n\n1234567890");

			// Start at line 2, col 3
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 3
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 3
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });

			// Ctrl+E - resets sticky column to end
			editor.handleInput("\x05"); // Ctrl+E
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (new sticky from col 5)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 5 });
		});

		it("resets sticky column on word movement (Ctrl+Left)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// Start at end of line 2 (col 11)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 11 });

			// Move up through empty line - establishes sticky col 11
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 11
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 11 });

			// Ctrl+Left - word movement resets sticky column
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 }); // Before "world"

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 6 (new sticky from col 6)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 6 });
		});

		it("resets sticky column on word movement (Ctrl+Right)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// Start at line 0, col 0
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x01"); // Ctrl+A
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			// Move down through empty line - establishes sticky col 0
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 0
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 0 });

			// Ctrl+Right - word movement resets sticky column
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 5 }); // After "hello"

			// Move up twice
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (new sticky from col 5)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 });
		});

		it("resets sticky column on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Go to line 0, col 8
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });

			// Move down through empty line - establishes sticky col 8
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 8 (sticky)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 8 });

			// Type something to create undo state - this clears sticky and sets col to 9
			editor.handleInput("X");
			expect(editor.getText()).toBe("1234567890\n\n12345678X90");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 9 });

			// Move up - establishes new sticky col 9
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 9
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 9 });

			// Undo - resets sticky column and restores cursor to line 2, col 8
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("1234567890\n\n1234567890");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 8 });

			// Move up - should capture new sticky from restored col 8, not old col 9
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 8 (new sticky from restored position)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });
		});

		it("handles multiple consecutive up/down movements", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\nab\ncd\nef\n1234567890");

			// Start at line 4, col 7
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 4, col: 7 });

			// Move up multiple times through short lines
			editor.handleInput("\x1b[A"); // Up - line 3, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 2, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 1, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 0, col 7 (restored)
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 7 });

			// Move down multiple times - sticky should still be 7
			editor.handleInput("\x1b[B"); // Down - line 1, col 2
			editor.handleInput("\x1b[B"); // Down - line 2, col 2
			editor.handleInput("\x1b[B"); // Down - line 3, col 2
			editor.handleInput("\x1b[B"); // Down - line 4, col 7 (restored)
			expect(editor.getCursor()).toStrictEqual({ line: 4, col: 7 });
		});

		it("moves correctly through wrapped visual lines without getting stuck", () => {
			const tui = createTestTUI(15, 24); // Narrow terminal
			const editor = new Editor(tui, defaultEditorTheme);

			// Line 0: short
			// Line 1: 30 chars = wraps to 3 visual lines at width 10 (after padding)
			editor.setText("short\n123456789012345678901234567890");
			editor.render(15); // This gives 14 layout width

			// Position at end of line 1 (col 30)
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 30 });

			// Move up repeatedly - should traverse all visual lines of the wrapped text
			// and eventually reach line 0
			editor.handleInput("\x1b[A"); // Up - to previous visual line within line 1
			expect(editor.getCursor().line).toBe(1);

			editor.handleInput("\x1b[A"); // Up - another visual line
			expect(editor.getCursor().line).toBe(1);

			editor.handleInput("\x1b[A"); // Up - should reach line 0
			expect(editor.getCursor().line).toBe(0);
		});

		it("handles setText resetting sticky column", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Establish sticky column
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[A"); // Up

			// setText should reset sticky column
			editor.setText("abcdefghij\n\nabcdefghij");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 10 }); // At end

			// Move up - should capture new sticky from current position (10)
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 10
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });
		});

		it("sets preferredVisualCol when pressing right at end of prompt (last line)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: 20 chars with 'x' at col 10
			// Line 1: empty
			// Line 2: 10 chars ending with '_'
			editor.setText("111111111x1111111111\n\n333333333_");

			// Go to line 0, press Ctrl+E (end of line) - col 20
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x05"); // Ctrl+E - move to end of line
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 20 });

			// Move down to line 2 - cursor clamped to col 10 (end of line)
			editor.handleInput("\x1b[B"); // Down to line 1, col 0
			editor.handleInput("\x1b[B"); // Down to line 2, col 10 (clamped)
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 10 });

			// Press Right at end of prompt - nothing visible happens, but sets preferredVisualCol to 10
			editor.handleInput("\x1b[C"); // Right - can't move, but sets preferredVisualCol
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 10 }); // Still at same position

			// Move up twice to line 0 - should use preferredVisualCol (10) to land on 'x'
			editor.handleInput("\x1b[A"); // Up to line 1, col 0
			editor.handleInput("\x1b[A"); // Up to line 0, col 10 (on 'x')
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });
		});

		it("handles editor resizes when preferredVisualCol is on the same line", () => {
			// Create editor with wider terminal
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			editor.setText("12345678901234567890\n\n12345678901234567890");

			// Start at line 2, col 15
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 15
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 15
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 15 });

			// Render with narrower width to simulate resize
			editor.render(12); // Width 12

			// Move down - sticky should be clamped to new width
			editor.handleInput("\x1b[B"); // Down - line 1
			editor.handleInput("\x1b[B"); // Down - line 2, col should be clamped
			expect(editor.getCursor().col).toBe(4);
		});

		it("handles editor resizes when preferredVisualCol is on a different line", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// Create a line that wraps into multiple visual lines at width 10
			// "12345678901234567890" = 20 chars, wraps to 2 visual lines at width 10
			editor.setText("short\n12345678901234567890");

			// Go to line 1, col 15
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 15 });

			// Move up to establish sticky col 15
			editor.handleInput("\x1b[A"); // Up to line 0
			// Line 0 has only 5 chars, so cursor at col 5
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 });

			// Narrow the editor
			editor.render(10);

			// Move down - preferredVisualCol was 15, but width is 10
			// Should land on line 1, clamped to width (visual col 9, which is logical col 9)
			editor.handleInput("\x1b[B"); // Down to line 1
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 8 });

			// Move up
			editor.handleInput("\x1b[A"); // Up - should go to line 0
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 5 }); // Line 0 only has 5 chars

			// Restore the original width
			editor.render(80);

			// Move down - preferredVisualCol was kept at 15
			editor.handleInput("\x1b[B"); // Down to line 1
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 15 });
		});

		it("rewrapped lines: target fits current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678");

			positionCursor(editor, 0, 18);
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 18 });

			// Narrow to width 10 (layoutWidth = 9).
			// Line 0 last segment has visual col max 9, line 1 first segment max 8
			editor.render(10);

			// Move down: cursor clamps to 8
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 8 });

			// Widen back. Move up, the current visual col wins
			editor.render(80);
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 8 });

			// Preferred was cleared by the rewrapped branch
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 8 });
		});

		it("rewrapped lines: target shorter than current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678\nab");

			positionCursor(editor, 0, 18);
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 18 });

			// Narrow to width 10 (layoutWidth = 9). Moving down clamps to col 8
			editor.render(10);
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 8 });

			// Widen the editor
			editor.render(80);

			// Move down to short line "ab".
			// preferredVisualCol is replaced with current visual col (8), cursor clamps to 2
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 2 });

			// Moving up restores to preferred col 8
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 8 });
		});
	});

	describe("Paste marker atomic behavior", () => {
		/** Helper: simulate a large paste that creates a marker */
		function pasteWithMarker(editor: Editor): string {
			const bigContent = "line\n".repeat(20).trimEnd(); // 20 lines
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// The editor replaces large pastes with a marker like "[paste #1 +20 lines]"
			return editor.getText();
		}

		/** Helper: 12-line paste content with a distinguishing tag */
		function bigPaste(tag: string): string {
			return Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n");
		}

		it("creates a paste marker for large pastes", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const text = pasteWithMarker(editor);
			expect(String(text)).toMatch(/\[paste #\d+ \+\d+ lines\]/);
		});

		it("treats paste marker as single unit for right arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");
			// Text: "A[paste #1 +20 lines]B", cursor at end

			// Go to start
			editor.handleInput("\x01"); // Ctrl+A
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

			// Right arrow: should move past "A"
			editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 });

			// Right arrow: should skip the entire marker
			editor.handleInput("\x1b[C");
			const marker = editor.getText().match(/\[paste #\d+ \+\d+ lines\]/)![0];
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 + marker.length });

			// Right arrow: should move past "B"
			editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 + marker.length + 1 });
		});

		it("treats paste marker as single unit for left arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");
			// Cursor at end

			// Left arrow: past "B"
			editor.handleInput("\x1b[D");
			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 + marker.length });

			// Left arrow: skip the entire marker
			editor.handleInput("\x1b[D");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 });

			// Left arrow: past "A"
			editor.handleInput("\x1b[D");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });
		});

		it("treats paste marker as single unit for backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// Position cursor right after the marker (before "B")
			editor.handleInput("\x01"); // Ctrl+A
			// Move past "A" and the marker
			editor.handleInput("\x1b[C"); // past "A"
			editor.handleInput("\x1b[C"); // past marker
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 + marker.length });

			// Backspace: should delete the entire marker at once
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("AB");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 });
		});

		it("does not reuse a paste id that is still referenced", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput(`\x1b[200~${bigPaste("ONE")}\x1b[201~`);
			const markerOne = editor.getText();
			expect(markerOne).toBe("[paste #1 +12 lines]");

			// Type a literal copy of the marker, then delete the second one:
			// the buffer still references id 1 through the first marker.
			editor.handleInput(`\x1b[200~${markerOne}\x1b[201~`);
			expect(editor.getText()).toBe(`${markerOne}${markerOne}`);
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe(markerOne);

			editor.handleInput(`\x1b[200~${bigPaste("TWO")}\x1b[201~`);
			const text = editor.getText();
			const expanded = editor.getExpandedText();
			expect(expanded.split("ONE0").length - 1, "ONE appears once").toBe(1);
			expect(expanded.split("TWO0").length - 1, "TWO appears once").toBe(1);
			expect(text.match(/\[paste #(\d+) \+12 lines\]/g)).toStrictEqual(["[paste #1 +12 lines]", "[paste #2 +12 lines]"]);
		});

		it("keeps deletion geometry correct when backspace renumbers 2-digit marker ids", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			for (let i = 0; i < 9; i++) {
				editor.handleInput(`\x1b[200~${bigPaste(`tag${i}`)}\x1b[201~`);
			}
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(`\x1b[200~${bigPaste("ten")}\x1b[201~`);
			const before = editor.getText();
			expect(String(before)).toMatch(/^\[paste #10 \+12 lines\]/);

			editor.handleInput("\x05"); // Ctrl+E
			editor.handleInput("\x7f"); // Backspace: delete the id-10 marker

			// The tail marker (20 chars) is removed and the id-10 marker in
			// front of the cursor shrinks to id 9: 201 - 20 - 1 = 180. The
			// cursor lands on the boundary of the renumbered marker.
			const after = editor.getText();
			expect(before.length).toBe(201);
			expect(after.length).toBe(180);
			expect(!after.endsWith("[")).toBeTruthy();
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 180 });
			expect(after.startsWith("[paste #9 "), `head is ${after.slice(0, 20)}`).toBeTruthy();
			assert.strictEqual(new Set(after.match(/\[paste #(\d+)/g)).size, 9);
			expect(!editor.getExpandedText().includes("tag80")).toBeTruthy();
			expect(editor.getExpandedText().includes("ten0")).toBeTruthy();
		});

		it("treats paste marker as single unit for forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			// Position cursor on "A" (col 0) then move right once to be just before marker
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // past "A", now at col 1 (start of marker)

			// Forward delete: should delete the entire marker at once
			editor.handleInput("\x1b[3~"); // Delete key
			expect(editor.getText()).toBe("AB");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 });
		});

		it("treats paste marker as single unit for word movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("X");
			editor.handleInput(" ");
			pasteWithMarker(editor);
			editor.handleInput(" ");
			editor.handleInput("Y");
			// Text: "X [paste #1 +20 lines] Y"

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// Go to start
			editor.handleInput("\x01"); // Ctrl+A

			// Ctrl+Right: skip "X"
			editor.handleInput("\x1b[1;5C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 });

			// Ctrl+Right: skip whitespace + marker (marker treated as single non-ws, non-punct unit)
			editor.handleInput("\x1b[1;5C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 2 + marker.length });
		});

		it("undo restores marker after backspace deletion", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const textBefore = editor.getText();

			// Position after marker
			editor.handleInput("\x01");
			editor.handleInput("\x1b[C"); // past A
			editor.handleInput("\x1b[C"); // past marker

			// Delete marker
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("AB");

			// Undo
			editor.handleInput("\x1b[45;5u");
			expect(editor.getText()).toBe(textBefore);
		});

		it("undo after paste marker deletion restores the paste registry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const paste = bigPaste("alpha");
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			editor.handleInput("\x7f"); // delete the marker
			editor.handleInput("\x1b[45;5u"); // undo: restores marker text and registry
			editor.handleInput("\r");
			expect(submitted).toBe(paste);
		});

		it("undo after deleting the first of two paste markers restores both registry entries", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const pasteA = bigPaste("alpha");
			const pasteB = bigPaste("beta");
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // #2 = B, cursor at end
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // right over marker #1
			editor.handleInput("\x7f"); // delete marker #1, renumbers #2 -> #1
			editor.handleInput("\x1b[45;5u"); // undo
			editor.handleInput("\r");
			expect(submitted).toBe(pasteA + pasteB);
		});

		it("renumbers the paste registry in ascending id order when markers are out of order in text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const pasteA = bigPaste("alpha");
			const pasteB = bigPaste("beta");
			const pasteC = bigPaste("gamma");
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // #2 = B, text: [#2][#1]
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(`\x1b[200~${pasteC}\x1b[201~`); // #3 = C, text: [#3][#2][#1]
			editor.handleInput("\x05"); // Ctrl+E
			editor.handleInput("\x7f"); // delete marker #1, renumber #3 -> #2 and #2 -> #1
			editor.handleInput("\r");
			expect(submitted).toBe(pasteC + pasteB);
		});

		it("undo after setText restores paste markers and registry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const paste = bigPaste("alpha");
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			editor.setText("replacement");
			editor.handleInput("\x1b[45;5u"); // undo
			editor.handleInput("\r");
			expect(submitted).toBe(paste);
		});

		it("setText with preservePasteRegistry keeps the registry for surviving markers", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const paste = bigPaste("alpha");
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`); // #1 = alpha
			// A programmatic replace that still contains the marker (e.g. a subclass
			// expanding one of several paste markers) must not orphan its entry.
			editor.setText(editor.getText(), { preservePasteRegistry: true });
			editor.handleInput("\r");
			expect(submitted).toBe(paste);
		});

		it("handles multiple paste markers in same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			pasteWithMarker(editor);
			editor.handleInput(" ");
			pasteWithMarker(editor);

			const text = editor.getText();
			const markers = [...text.matchAll(/\[paste #\d+ \+\d+ lines\]/g)];
			expect(markers.length).toBe(2);

			// Go to start
			editor.handleInput("\x01");

			// Right arrow: should skip first marker atomically
			editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: markers[0]![0].length });

			// Right arrow: past space
			editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: markers[0]![0].length + 1 });

			// Right arrow: should skip second marker atomically
			editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({
				line: 0,
				col: markers[0]![0].length + 1 + markers[1]![0].length,
			});
		});

		it("does not treat manually typed marker-like text as atomic (no valid paste ID)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// Type text that matches the pattern but was typed manually (no paste entry)
			const fakeMarker = "[paste #99 +5 lines]";
			for (const ch of fakeMarker) editor.handleInput(ch);

			expect(editor.getText()).toBe(fakeMarker);

			// No paste with ID 99 exists, so the marker is NOT treated atomically.
			// Right arrow should move one grapheme at a time.
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // Right
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 1 }); // Just past "["
		});

		it("does not crash when paste marker is wider than terminal width", () => {
			// Reproduce: terminal width 8, paste marker "[paste #1 +47 lines]" (21 chars)
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);
			const bigContent = "line\n".repeat(47).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/);
			expect(marker, "paste marker should be created").toBeTruthy();
			expect(visibleWidth(marker[0]) > 8, "marker should be wider than render width").toBeTruthy();

			// Render at very narrow width - should not throw
			const lines = editor.render(8);
			// Every rendered line must fit within the width (marker is split)
			for (const line of lines) {
				expect(visibleWidth(line) <= 8, `line exceeds width 8: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`).toBeTruthy();
			}
		});

		it("does not crash when text + paste marker exceeds terminal width with cursor on marker", () => {
			// Reproduce: terminal width 54, text "b".repeat(35) + "[paste #1 +27 lines]" + "bbbb"
			// Cursor lands on the paste marker after word-wrap, causing the rendered line
			// to be 55 visible chars (1 over the width).
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			// Type 35 'b' characters
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// Paste 27 lines
			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// Type a few more characters
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// Move cursor left to land on the paste marker
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // now on the paste marker

			// Render at width 54 - should not throw
			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				expect(visibleWidth(line) <= renderWidth, `line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`).toBeTruthy();
			}
		});

		it("wordWrapLine re-checks overflow after backtracking to wrap opportunity", () => {
			// Reproduce crash #2: " " + "b".repeat(35) + atomic_marker(20 chars) + "bbbb"
			// layoutWidth=53. After wrapping at the space, the remaining 35 b's + marker = 55
			// must trigger a second force-break instead of silently overflowing.
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			// Type a space, then 35 b's
			editor.handleInput(" ");
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// Paste 27 lines to create marker
			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// Type trailing chars
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// Render at width 54 (contentWidth=54, layoutWidth=53 with paddingX=0)
			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				expect(visibleWidth(line) <= renderWidth, `line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`).toBeTruthy();
			}
		});

		it("expands large pasted content literally in getExpandedText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			expect(String(editor.getText())).toMatch(/\[paste #\d+ \+\d+ lines\]/);
			expect(editor.getExpandedText()).toBe(pastedText);
		});

		it("snaps to the paste marker start when navigating down into it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: long enough text to establish a sticky column
			editor.setText("12345678901234567890\n\nhello ");

			// Create a large paste to get a marker
			const bigContent = "x".repeat(2000);
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			editor.render(80);

			const text = editor.getText();
			const _marker = text.match(/\[paste #\d+ \d+ chars\]/)![0];
			// Line 0: "12345678901234567890"
			// Line 1: "" (empty)
			// Line 2: "hello [paste #1 2000 chars]"
			//         marker starts at col 6

			// Navigate to line 0, col 10
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Right 10
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });

			// Down to empty line
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			// Down to paste marker line - sticky col 10 falls inside marker (starts at col 6).
			// Cursor should snap to start of marker (col 6), not end (col 6 + marker.length).
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 6 });
		});

		it("preserves sticky column when navigating through paste marker line", () => {
			const tui = createTestTUI(30, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// Build:
			// Line 0: "1234567890123456" (16 chars)
			// Line 1: "" (empty)
			// Line 2: "[paste #1 2000 chars]" (22 chars, paste marker)
			// Line 3: "" (empty)
			// Line 4: "abcdefghijklmnop" (16 chars)
			for (const ch of "1234567890123456") editor.handleInput(ch);
			editor.handleInput("\n");
			editor.handleInput("\n");
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			editor.handleInput("\n");
			editor.handleInput("\n");
			for (const ch of "abcdefghijklmnop") editor.handleInput(ch);
			editor.render(30);

			// Navigate to line 0, col 10
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 10 });

			// Down to empty line - sticky col 10 established
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 0 });

			// Down to paste marker - cursor snapped to col 0 (start of marker)
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 2, col: 0 });

			// Down to empty line
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 3, col: 0 });

			// Down to last line - should restore sticky col 10
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 4, col: 10 });
		});

		it("does not get stuck moving down from a multi-visual-line paste marker", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// Build:
			// Logical line 0: "abcdefgh" + marker(21 chars) + "ijklmnopqr"
			// Logical line 1: "123456789012345678"
			//
			// Marker "[paste #1 +100 lines]" (21 chars) is wider than the
			// terminal (20). Word-wrap splits at the space before "lines",
			// producing:
			//   VL1: abcdefgh              (startCol 0,  len 8)
			//   VL2: [paste #1 +100        (startCol 8,  len 15) <- marker head
			//   VL3: lines]ijklmnopqr      (startCol 23, len 16) <- marker tail + content
			//   VL4: 123456789012345678    (line 1)
			//
			// On VL3 the marker tail "lines]" occupies visual cols 0-5.
			// Content ("i") starts at visual col 6 = logical col 29.
			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			const text = editor.getText();
			const markerMatch = text.match(/\[paste #\d+ \+\d+ lines]/);
			expect(markerMatch, "paste marker should be created").toBeTruthy();
			const markerLen = markerMatch[0].length; // 21
			expect(markerLen > 20, "marker should be wider than terminal").toBeTruthy();
			const markerStart = 8;
			const markerEnd = markerStart + markerLen; // 29

			// Navigate to line 0, col 6 (on "g"). Preferred col 6 is past the
			// marker tail on VL3, so the cursor should land on content ("i" at
			// col 29) without snapping back.
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Right to col 6
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 });

			// Down: cursor lands on paste marker start
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: markerStart });

			// Down again: preferred col 6 lands at VL3 col 29 ("i"), which is
			// past the marker. Cursor stays on line 0.
			editor.handleInput("\x1b[B");
			expect(editor.getCursor().line).toBe(0);
			expect(editor.getCursor().col).toBe(markerEnd); // col 29 = "i"

			// Up: back to paste marker
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: markerStart });

			// Up again: back to col 6 ("g")
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 6 });
		});

		it("skips marker continuation VLs when preferred col falls in marker tail", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// Same layout. Start at col 3 ("d"). Preferred col 3 maps to VL3
			// visual col 3 which is inside the "lines]" marker tail.
			// moveToVisualLine detects the continuation VL and skips to VL4
			// (line 1).
			//   VL1: abcdefgh              (startCol 0,  len 8)
			//   VL2: [paste #1 +100        (startCol 8,  len 15) <- marker head
			//   VL3: lines]ijklmnopqr      (startCol 23, len 16) <- marker tail + content
			//   VL4: 123456789012345678    (line 1)
			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			// Navigate to line 0, col 3 (on "d")
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });

			// Down: marker
			editor.handleInput("\x1b[B");
			expect(editor.getCursor().col).toBe(8);

			// Down: skips VL3 (col 3 in marker tail) and lands on line 1
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toStrictEqual({ line: 1, col: 3 });

			// Round-trip back
			editor.handleInput("\x1b[A");
			expect(editor.getCursor().col).toBe(8); // marker
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });
		});

		it("submits large pasted content literally", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			editor.handleInput("\r");

			expect(submitted).toBe(pastedText);
		});
	});
});

describe("wordWrapLine narrow width", () => {
	it("does not recurse infinitely on a wide grapheme at maxWidth 1", () => {
		const chunks = wordWrapLine("中", 1);
		expect(chunks.map((c) => c.text)).toStrictEqual(["中"]);
	});

	it("splits CJK text into per-grapheme overflow chunks at maxWidth 1", () => {
		const chunks = wordWrapLine("中文文本", 1);
		expect(chunks.map((c) => c.text)).toStrictEqual(["中", "文", "文", "本"]);
		expect(chunks.map((c) => [c.startIndex, c.endIndex])).toStrictEqual([
				[0, 1],
				[1, 2],
				[2, 3],
				[3, 4],
			]);
	});

	it("handles mixed narrow and wide graphemes at maxWidth 1", () => {
		const chunks = wordWrapLine("ab中cd", 1);
		expect(chunks.map((c) => c.text)).toStrictEqual(["a", "b", "中", "c", "d"]);
	});

	it("still re-wraps multi-grapheme atomic segments at narrow widths", () => {
		// Paste markers arrive as one atomic pre-segmented unit; they can
		// still be broken down grapheme by grapheme — recursion must keep
		// that ability.
		const marker = "[paste #1]";
		const preSegmented: Intl.SegmentData[] = [{ segment: marker, index: 0, input: marker }];
		const chunks = wordWrapLine(marker, 3, preSegmented);
		expect(chunks.length > 1).toBeTruthy();
		expect(chunks.map((c) => c.text).join("")).toBe(marker);
	});

	it("does not recurse infinitely on a multi-code-unit grapheme at maxWidth 1", () => {
		// Guards "grapheme count, not code-unit length": a ZWJ family emoji
		// is 11 code units but 1 grapheme (width 2). A guard mistakenly
		// written as `grapheme.length <= 1` passes the BMP CJK cases yet
		// recurses forever on this input.
		const chunks = wordWrapLine("👨‍👩‍👧‍👦", 1);
		expect(chunks.map((c) => c.text)).toStrictEqual(["👨‍👩‍👧‍👦"]);
	});
});

describe("Editor narrow width rendering", () => {
	it("renders CJK text without crashing at widths 1-8 (default padding)", () => {
		for (let width = 1; width <= 8; width++) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("你好世界");
			expect(() => editor.render(width)).not.toThrow();
		}
	});

	it("renders CJK text without crashing at widths 1-8 (paddingX 4, matches kimi-code)", () => {
		for (let width = 1; width <= 8; width++) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { paddingX: 4 });
			editor.setText("你好，世界！");
			expect(() => editor.render(width)).not.toThrow();
		}
	});

	it("recalls history without crashing after rendering at width 1", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.addToHistory("你好世界");
		editor.render(1); // narrow render pins lastWidth at 1
		expect(() => {
			(editor as unknown as { navigateHistory(direction: 1 | -1): void }).navigateHistory(-1);
			// Recalling CJK text re-wraps it at the pinned narrow width —
			// without the guard this overflows the stack.
			editor.render(1);
		}).not.toThrow();
		expect(editor.getText()).toBe("你好世界");
	});

	it("renders inside a TUI at 5 columns without crashing or overflowing", async () => {
		const terminal = new VirtualTerminal(5, 12);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme, { paddingX: 4 });
		tui.addChild(editor);
		editor.setText("你好世界");
		tui.start();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		// Assert the exact visible rows: without truncation, xterm
		// auto-wraps the overwide rows and the structure shifts, turning
		// these assertions red (a tautological every(visibleWidth <= 5)
		// check cannot fail on a 5-column terminal and was removed).
		// Each content row is 6 columns wide (left padding 2 + CJK char 2
		// + right padding 2) and is truncated to 5, leaving the trailing
		// space.
		expect(viewport[0]).toBe("─────");
		expect(viewport[1]).toBe("  你 ");
		expect(viewport[2]).toBe("  好 ");
		expect(viewport[3]).toBe("  世 ");
		expect(viewport[4]).toBe("  界 ");
		expect(viewport[5]).toBe("─────");
		tui.stop();
	});

	it("does not throw at zero or negative widths", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("你好世界");
		expect(() => editor.render(0)).not.toThrow();
		expect(() => editor.render(-1)).not.toThrow();
	});
});
