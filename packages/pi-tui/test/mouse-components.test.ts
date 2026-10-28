import { expect, describe, it } from "bun:test";
import { AltScreenSearchComponent } from "../src/alt-screen-search.ts";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Container, type TuiMouseEvent, type TuiMouseEventType } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: selectTheme,
};

class InputOverlay extends Container {
	readonly input = new Input();

	constructor() {
		super();
		this.addChild(this.input);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

describe("mouse-aware components", () => {
	it("positions a single-line input cursor on press", () => {
		const input = new Input();
		input.setValue("hello");
		input.render(20);

		expect(input.handleMouse(mouse("press", 4, 0, 20, 1))?.handled).toBe(true);
		input.handleInput("X");
		expect(input.getValue()).toBe("heXllo");
	});

	it("positions the input cursor relative to a custom prompt", () => {
		const input = new Input({ prompt: " " });
		input.setValue("hello");
		input.render(20);

		expect(input.handleMouse(mouse("press", 3, 0, 20, 1))?.handled).toBe(true);
		input.handleInput("X");
		expect(input.getValue()).toBe("heXllo");
	});

	it("routes search field presses to the embedded input", () => {
		let query = "";
		const component = new AltScreenSearchComponent((value) => {
			query = value;
		});
		component.render(40);
		component.handleInput("hello");

		expect(component.handleMouse(mouse("press", 4, 1, 40, 3))?.handled).toBe(true);
		component.handleInput("X");
		expect(query).toBe("heXllo");
	});

	it("selects and activates list rows", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				{ value: "d", label: "D" },
				{ value: "e", label: "E" },
			],
			3,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};

		expect(list.handleMouse(mouse("press", 1, 2, 40, 3))?.handled).toBe(true);
		expect(list.getSelectedItem()?.value).toBe("c");
		expect(list.handleMouse(mouse("click", 1, 2, 40, 3))?.handled).toBe(true);
		expect(selected).toBe("c");
	});

	it("activates settings rows", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
				{ id: "third", label: "Third", currentValue: "low", values: ["low", "high"] },
				{ id: "fourth", label: "Fourth", currentValue: "x", values: ["x", "y"] },
			],
			3,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleMouse(mouse("press", 1, 2, 40, 5));
		list.handleMouse(mouse("click", 1, 2, 40, 5));
		expect(changes).toStrictEqual([{ id: "third", value: "high" }]);
	});

	for (const row of [0, 4]) {
		it(`ignores hover and clicks visible select-list row ${row} after scrolling`, () => {
			const list = new SelectList(
				Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` })),
				5,
				selectTheme,
			);
			const changes: string[] = [];
			let selected: string | undefined;
			list.onSelectionChange = (item) => changes.push(item.value);
			list.onSelect = (item) => {
				selected = item.value;
			};
			list.setSelectedIndex(5);
			list.handleMouse({ ...mouse("wheel", 1, row), wheelDelta: 1 });
			expect(list.getSelectedItem()?.value).toBe("item-6");
			expect(changes).toStrictEqual(["item-6"]);
			const before = list.render(80);
			expect(String(before[row])).toMatch(new RegExp(`Item ${4 + row}$`));

			for (const y of [0, 1, 2, 3, 4, row]) {
				expect(list.handleMouse({ ...mouse("move", 1, y), button: "none" })).toBe(undefined);
				expect(list.render(80)).toStrictEqual(before);
			}
			expect(list.getSelectedItem()?.value).toBe("item-6");
			expect(changes).toStrictEqual(["item-6"]);
			expect(selected).toBe(undefined);

			list.handleMouse(mouse("press", 1, row));
			list.render(80);
			list.handleMouse(mouse("click", 1, row));
			expect(selected).toBe(`item-${4 + row}`);
			expect(changes).toStrictEqual(["item-6", `item-${4 + row}`]);
		});

		it(`ignores hover and clicks visible settings row ${row} after scrolling`, () => {
			const changes: Array<{ id: string; value: string }> = [];
			const list = new SettingsList(
				Array.from({ length: 12 }, (_, i) => ({
					id: `item-${i}`,
					label: `Item ${i}`,
					description: `Description ${i}`,
					currentValue: "off",
					values: ["off", "on"],
				})),
				5,
				settingsTheme,
				(id, value) => changes.push({ id, value }),
				() => {},
				{ enableSearch: true },
			);
			list.selectItem("item-5");
			list.handleMouse({ ...mouse("wheel", 1, row + 2), wheelDelta: 1 });
			const before = list.render(80);
			expect(String(before[4])).toMatch(/^> Item 6/);
			expect(String(before[row + 2])).toMatch(new RegExp(`Item ${4 + row} `));

			for (const y of [0, 1, 2, 3, 4, row]) {
				expect(list.handleMouse({ ...mouse("move", 1, y + 2), button: "none" })).toBe(undefined);
				expect(list.render(80)).toStrictEqual(before);
			}
			expect(changes).toStrictEqual([]);

			list.handleMouse(mouse("press", 1, row + 2));
			list.render(80);
			list.handleMouse(mouse("click", 1, row + 2));
			expect(changes).toStrictEqual([{ id: `item-${4 + row}`, value: "on" }]);
		});
	}

	it("keeps a delegating overlay focused when its nested input is clicked", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new InputOverlay();
		overlay.input.setValue("hi");
		tui.start();
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		terminal.sendInput("!");
		await terminal.waitForRender();

		expect(overlay.input.getValue()).toBe("hi!");
		expect(tui.getFocusedComponent()).toBe(overlay);
		tui.stop();
	});

	it("positions and focuses the multiline editor through alternate-screen dispatch", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		expect(editor.getText()).toBe("heXllo");
		expect(tui.getFocusedComponent()).toBe(editor);
		tui.stop();
	});

	it("translates clicks by the cropped line offset of an over-tall component", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
		tui.setLayoutRoot(editor);
		tui.start();
		tui.setFocus(editor);
		await terminal.waitForRender();

		// The editor renders 7 rows into 5, so the layout crops the top row to
		// keep the cursor row visible; the second screen row displays "l7".
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		expect(editor.getText()).toBe("l1\nl2\nl3\nl4\nl5\nl6\nlX7\nl8\nl9\nl10");
		tui.stop();
	});

	it("dispatches cropped rows within the uncropped height to container subclasses", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
		// A Container subclass with its own handleMouse (like the app's
		// GutterContainer) receives dispatch instead of being skipped.
		const wrapper = new (class extends Container {
			override handleMouse(event: TuiMouseEvent) {
				return super.handleMouse(event);
			}
		})();
		wrapper.addChild(editor);
		tui.setLayoutRoot(wrapper);
		tui.start();
		tui.setFocus(editor);
		await terminal.waitForRender();

		// The wrapper renders 7 rows into 5 and is cropped by one row; the last
		// screen row displays "l10".
		terminal.sendInput("\x1b[<0;2;5M");
		terminal.sendInput("\x1b[<0;2;5m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		expect(editor.getText()).toBe("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nlX10");
		tui.stop();
	});

	it("maps clicks from the grapheme-aligned scroll origin", () => {
		const input = new Input({ prompt: "" });
		input.setValue("😀a😀bc");
		// setValue keeps the cursor at 0; walk to the end, then back to just
		// after "a" so horizontal scrolling starts inside the first emoji.
		for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");
		for (let i = 0; i < 3; i++) input.handleInput("\x1b[D");
		input.render(5);

		// "a" is the first displayed character; clicking it must place the
		// cursor after "😀" rather than at the raw scroll column.
		expect(input.handleMouse(mouse("press", 0, 0, 5, 1))?.handled).toBe(true);
		input.handleInput("X");
		expect(input.getValue()).toBe("😀Xa😀bc");
	});

	it("selects and copies editor text on drag instead of moving the cursor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();
		const cursorBefore = editor.getCursor();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		expect(copied).toStrictEqual(["hello"]);
		expect(editor.getCursor()).toStrictEqual(cursorBefore);
		tui.stop();
	});
});
