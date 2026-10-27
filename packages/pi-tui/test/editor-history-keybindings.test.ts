import assert from "node:assert";
import { expect, afterEach, describe, it } from "bun:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("Editor prompt history keybindings", () => {
	it("browses history directly without first moving the cursor", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");
		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("newer\nmultiline prompt");
		expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("older prompt");

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("newer\nmultiline prompt");
		expect(editor.getCursor()).toStrictEqual({ line: 1, col: 16 });

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
		expect(editor.getCursor()).toStrictEqual({ line: 0, col: 3 });
	});

	it("leaves a wrapped single-line entry on Down", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		const long = "one long single line prompt that wraps at twenty";
		editor.addToHistory(long);
		editor.render(20);

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe(long);
		expect(editor.getCursor()).toStrictEqual({ line: 0, col: 0 });

		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("");
	});
});
