import { expect, describe, it } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";

describe("KeybindingsManager", () => {
	it("binds Ctrl+J as a default newline alias", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		expect(keybindings.getKeys("tui.input.newLine")).toStrictEqual(["shift+enter", "ctrl+j"]);
		expect(keybindings.matches("\n", "tui.input.newLine")).toBe(true);
		expect(keybindings.matches("\x1b[106;5u", "tui.input.newLine")).toBe(true);
	});

	it("binds modified and unmodified editor viewport navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		expect(keybindings.getKeys("tui.editor.cursorLineStart")).toStrictEqual(["home", "ctrl+home", "ctrl+a"]);
		expect(keybindings.getKeys("tui.editor.cursorLineEnd")).toStrictEqual(["end", "ctrl+end", "ctrl+e"]);
		expect(keybindings.getKeys("tui.editor.pageUp")).toStrictEqual(["pageUp", "ctrl+pageUp"]);
		expect(keybindings.getKeys("tui.editor.pageDown")).toStrictEqual(["pageDown", "ctrl+pageDown"]);
	});

	it("leaves dedicated prompt history navigation unbound by default", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		expect(keybindings.getKeys("tui.editor.historyPrevious")).toStrictEqual([]);
		expect(keybindings.getKeys("tui.editor.historyNext")).toStrictEqual([]);
	});

	it("binds unmodified terminal viewport shortcuts to alternate-screen navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		expect(keybindings.getKeys("tui.altScreen.pageUp")).toStrictEqual(["pageUp"]);
		expect(keybindings.getKeys("tui.altScreen.pageDown")).toStrictEqual(["pageDown"]);
		expect(keybindings.getKeys("tui.altScreen.halfPageUp")).toStrictEqual([]);
		expect(keybindings.getKeys("tui.altScreen.halfPageDown")).toStrictEqual([]);
		expect(keybindings.getKeys("tui.altScreen.lineUp")).toStrictEqual([]);
		expect(keybindings.getKeys("tui.altScreen.lineDown")).toStrictEqual([]);
		expect(keybindings.getKeys("tui.altScreen.previousPrompt")).toStrictEqual(["ctrl+shift+up", "ctrl+up"]);
		expect(keybindings.getKeys("tui.altScreen.nextPrompt")).toStrictEqual(["ctrl+shift+down", "ctrl+down"]);
		expect(keybindings.getKeys("tui.altScreen.search")).toStrictEqual(["ctrl+shift+f"]);
		expect(keybindings.getKeys("tui.altScreen.searchNext")).toStrictEqual(["enter", "ctrl+g"]);
		expect(keybindings.getKeys("tui.altScreen.searchPrevious")).toStrictEqual(["shift+enter", "ctrl+shift+g"]);
		expect(keybindings.getKeys("tui.altScreen.searchClose")).toStrictEqual(["escape"]);
		expect(keybindings.getKeys("tui.altScreen.top")).toStrictEqual(["home"]);
		expect(keybindings.getKeys("tui.altScreen.bottom")).toStrictEqual(["end"]);
	});

	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		expect(keybindings.getKeys("tui.input.submit")).toStrictEqual(["enter", "ctrl+enter"]);
		expect(keybindings.getKeys("tui.select.confirm")).toStrictEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		expect(keybindings.getKeys("tui.select.up")).toStrictEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toStrictEqual(["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.getConflicts()).toStrictEqual([
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toStrictEqual(["left", "ctrl+b"]);
	});
});
