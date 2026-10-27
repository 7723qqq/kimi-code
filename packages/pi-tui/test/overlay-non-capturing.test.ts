import { expect, describe, it } from "bun:test";
import type { Component, Focusable } from "../src/tui.ts";
import { Container, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class FocusableOverlay implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI overlay non-capturing", () => {
	describe("focus management", () => {
		it("non-capturing overlay preserves focus on creation", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay, { nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(overlay.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("focus() transfers focus to the overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(false);
				expect(overlay.focused).toBe(true);
				expect(handle.isFocused()).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() restores previous focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(overlay.focused).toBe(false);
				expect(handle.isFocused()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("setHidden(false) on non-capturing overlay does not auto-focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.setHidden(true);
				handle.setHidden(false);
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(overlay.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("hide() when overlay is not focused does not change focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.hide();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("hide() when focused restores focus correctly", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				handle.hide();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(overlay.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay removed with non-capturing below restores focus to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			const capturing = new FocusableOverlay(["CAP"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				const handle = tui.showOverlay(capturing);
				expect(capturing.focused).toBe(true);
				handle.hide();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(nonCapturing.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("sub-overlay cleanup then hideOverlay restores focus and input to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const timer = new FocusableOverlay(["TIMER"]);
			const controller = new FocusableOverlay(["CTRL"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
				tui.showOverlay(controller);
				expect(controller.focused).toBe(true);
				expect(editor.focused).toBe(false);
				timerHandle.hide();
				tui.hideOverlay();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(controller.focused).toBe(false);
				expect(timer.focused).toBe(false);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(controller.inputs).toStrictEqual([]);
				expect(timer.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("removed focused child overlay does not become parent overlay fallback", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const child = new FocusableOverlay(["CHILD"]);
			const parent = new FocusableOverlay(["PARENT"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const childHandle = tui.showOverlay(child, { nonCapturing: true });
				childHandle.focus();
				const parentHandle = tui.showOverlay(parent);
				expect(parent.focused).toBe(true);

				childHandle.hide();
				parentHandle.hide();
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				expect(editor.inputs).toStrictEqual(["x"]);
				expect(child.inputs).toStrictEqual([]);
				expect(parent.inputs).toStrictEqual([]);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("microtask-deferred sub-overlay pattern (showExtensionCustom simulation) restores focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const timer = new FocusableOverlay(["TIMER"]);
			const controller = new FocusableOverlay(["CTRL"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				// Simulate showExtensionCustom: factory creates timer synchronously,
				// then .then() pushes controller as a microtask
				let timerHandle: ReturnType<typeof tui.showOverlay> | null = null;
				let doneFn: () => void = () => {
					throw new Error("doneFn was not initialized");
				};

				const overlayPromise = new Promise<void>((resolve) => {
					doneFn = () => {
						if (!timerHandle) throw new Error("timerHandle was not initialized");
						timerHandle.hide();
						tui.hideOverlay();
						resolve();
					};
					timerHandle = tui.showOverlay(timer, { nonCapturing: true });
					// .then() runs as microtask — same as showExtensionCustom
					Promise.resolve(controller).then((c) => {
						tui.showOverlay(c);
					});
				});

				await Promise.resolve();
				await renderAndFlush(tui, terminal);

				expect(controller.focused).toBe(true);
				expect(editor.focused).toBe(false);

				// Simulate Esc: cleanup + close (from inside handleInput)
				doneFn();
				// Now await the promise (simulating showExtensionCustom resolving)
				await overlayPromise;
				await renderAndFlush(tui, terminal);

				expect(editor.focused, "editor should regain focus").toBe(true);
				expect(controller.focused).toBe(false);
				expect(timer.focused).toBe(false);

				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs, "editor should receive input after close").toStrictEqual(["x"]);
				expect(controller.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("handleInput redirection skips non-capturing overlays when focused overlay becomes invisible", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const fallbackCapturing = new FocusableOverlay(["FALLBACK"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			const primary = new FocusableOverlay(["PRIMARY"]);
			let isVisible = true;
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(fallbackCapturing);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				tui.showOverlay(primary, { visible: () => isVisible });
				expect(primary.focused).toBe(true);
				isVisible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(primary.inputs).toStrictEqual([]);
				expect(nonCapturing.inputs).toStrictEqual([]);
				expect(fallbackCapturing.inputs).toStrictEqual(["x"]);
				expect(fallbackCapturing.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("active base focus replacement receives close input before overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") {
					tui.setFocus(replacement);
				}
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					tui.setFocus(editor);
				}
			};
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				expect(overlay.focused).toBe(true);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				expect(replacement.focused).toBe(true);

				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);
				expect(replacement.inputs).toStrictEqual(["\r"]);
				expect(overlay.inputs).toStrictEqual(["b"]);
				expect(overlay.focused).toBe(true);

				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual(["b", "x"]);
			} finally {
				tui.stop();
			}
		});

		it("active replacement still receives input when it is another overlay preFocus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const passive = new FocusableOverlay(["PASSIVE"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") {
					tui.setFocus(replacement);
				}
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					tui.setFocus(editor);
				}
			};
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.setFocus(replacement);
				tui.showOverlay(passive, { nonCapturing: true });
				tui.setFocus(editor);
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				expect(replacement.focused).toBe(true);

				terminal.sendInput("1");
				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);
				expect(replacement.inputs).toStrictEqual(["1", "\r"]);
				expect(overlay.inputs).toStrictEqual(["b"]);
				expect(overlay.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("blocked replacement can move focus internally before overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const base = new Container();
			const editor = new FocusableOverlay(["EDITOR"]);
			const firstReplacement = new FocusableOverlay(["FIRST"]);
			const secondReplacement = new FocusableOverlay(["SECOND"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(firstReplacement);
			};
			firstReplacement.handleInput = (data: string) => {
				firstReplacement.inputs.push(data);
				if (data === "n") tui.setFocus(secondReplacement);
			};
			secondReplacement.handleInput = (data: string) => {
				secondReplacement.inputs.push(data);
				if (data === "\r") {
					base.clear();
					base.addChild(editor);
					tui.setFocus(editor);
				}
			};
			base.addChild(editor);
			base.addChild(firstReplacement);
			base.addChild(secondReplacement);
			tui.addChild(base);
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("n");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("2");
				terminal.sendInput("\r");
				await renderAndFlush(tui, terminal);

				expect(overlay.inputs).toStrictEqual(["b"]);
				expect(firstReplacement.inputs).toStrictEqual(["n"]);
				expect(secondReplacement.inputs).toStrictEqual(["2", "\r"]);
				expect(overlay.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("removed replacement restores overlay even when overlay preFocus differs from next focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const base = new Container();
			const editor = new FocusableOverlay(["EDITOR"]);
			const palette = new FocusableOverlay(["PALETTE"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(replacement);
			};
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") {
					base.clear();
					base.addChild(editor);
					tui.setFocus(editor);
				}
			};
			base.addChild(editor);
			base.addChild(palette);
			base.addChild(replacement);
			tui.addChild(base);
			tui.setFocus(palette);
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				expect(overlay.inputs).toStrictEqual(["b", "x"]);
				expect(replacement.inputs).toStrictEqual(["\r"]);
				expect(editor.inputs).toStrictEqual([]);
				expect(overlay.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("unfocus target releases a blocked overlay while replacement remains focused", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const fallback = new FocusableOverlay(["FALLBACK"]);
			const target = new FocusableOverlay(["TARGET"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") tui.setFocus(fallback);
			};
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const overlayHandle = tui.showOverlay(overlay);
				overlay.handleInput = (data: string) => {
					overlay.inputs.push(data);
					if (data === "b") {
						tui.setFocus(replacement);
						overlayHandle.unfocus({ target });
					}
				};

				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				expect(replacement.focused).toBe(true);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);

				expect(overlay.inputs).toStrictEqual(["b"]);
				expect(replacement.inputs).toStrictEqual(["\r"]);
				expect(fallback.inputs).toStrictEqual([]);
				expect(target.inputs).toStrictEqual(["x"]);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores focus to a visible focused overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay);
				expect(overlay.focused).toBe(true);
				tui.setFocus(replacement);
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual(["x"]);
				expect(editor.inputs).toStrictEqual([]);
				expect(overlay.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores focus to explicitly focused raw sub-overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const controller = new FocusableOverlay(["CONTROLLER"]);
			const subOverlay = new FocusableOverlay(["SUB"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(controller);
				const subHandle = tui.showOverlay(subOverlay, { nonCapturing: true });
				subHandle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(subOverlay.inputs).toStrictEqual(["x"]);
				expect(controller.inputs).toStrictEqual([]);
				expect(editor.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("passive non-capturing overlay does not regain input after base focus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const passive = new FocusableOverlay(["PASSIVE"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(passive, { nonCapturing: true });
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(passive.inputs).toStrictEqual([]);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("explicitly focused non-capturing overlay regains input after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["NC"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual(["x"]);
				expect(editor.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() prevents visible overlay from regaining input", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				handle.unfocus();
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(overlay.inputs).toStrictEqual([]);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("setFocus(null) explicitly clears visible overlay restore", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay);
				tui.setFocus(null);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual([]);
				expect(overlay.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("blocked replacement setFocus(null) resumes the visible overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			replacement.handleInput = (data: string) => {
				replacement.inputs.push(data);
				if (data === "\r") tui.setFocus(null);
			};
			overlay.handleInput = (data: string) => {
				overlay.inputs.push(data);
				if (data === "b") tui.setFocus(replacement);
			};
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay);
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				terminal.sendInput("\r");
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(replacement.inputs).toStrictEqual(["\r"]);
				expect(overlay.inputs).toStrictEqual(["b", "x"]);
				expect(overlay.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("temporarily invisible focused overlay falls back without losing restore eligibility", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			let visible = true;
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(overlay, { visible: () => visible });
				tui.setFocus(editor);
				visible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(overlay.inputs).toStrictEqual([]);
				visible = true;
				terminal.sendInput("y");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(overlay.inputs).toStrictEqual(["y"]);
			} finally {
				tui.stop();
			}
		});

		it("temporarily invisible focused overlay with null preFocus restores when visible again", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			let visible = true;
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(overlay, { visible: () => visible });
				visible = false;
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual([]);
				visible = true;
				terminal.sendInput("y");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual(["y"]);
			} finally {
				tui.stop();
			}
		});

		it("cyclic overlay preFocus ancestry does not hang focus changes", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(overlay);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(editor.inputs).toStrictEqual(["x"]);
				expect(overlay.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("handleInput restores the focus-order top overlay after base focus steal", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const lower = new FocusableOverlay(["LOWER"]);
			const upper = new FocusableOverlay(["UPPER"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const lowerHandle = tui.showOverlay(lower);
				tui.showOverlay(upper);
				lowerHandle.focus();
				tui.setFocus(editor);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(lower.inputs).toStrictEqual(["x"]);
				expect(upper.inputs).toStrictEqual([]);
				expect(editor.inputs).toStrictEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("hideOverlay() does not reassign focus when topmost overlay is non-capturing", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const capturing = new FocusableOverlay(["CAP"]);
			const nonCapturing = new FocusableOverlay(["NC"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				tui.showOverlay(capturing);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				expect(capturing.focused).toBe(true);
				tui.hideOverlay();
				await renderAndFlush(tui, terminal);
				expect(capturing.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("multiple capturing and non-capturing overlays restore focus through removals", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const c1 = new FocusableOverlay(["C1"]);
			const n1 = new FocusableOverlay(["N1"]);
			const c2 = new FocusableOverlay(["C2"]);
			const n2 = new FocusableOverlay(["N2"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const c1Handle = tui.showOverlay(c1);
				tui.showOverlay(n1, { nonCapturing: true });
				const c2Handle = tui.showOverlay(c2);
				tui.showOverlay(n2, { nonCapturing: true });
				expect(c2.focused).toBe(true);
				c2Handle.hide();
				await renderAndFlush(tui, terminal);
				expect(c1.focused).toBe(true);
				c1Handle.hide();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay unfocus() on topmost capturing overlay falls back to preFocus", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const capturing = new FocusableOverlay(["CAP"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(capturing);
				expect(capturing.focused).toBe(true);
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(capturing.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});
	});

	describe("no-op guards", () => {
		it("focus() on hidden overlay is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.setHidden(true);
				handle.focus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(handle.isFocused()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("focus() after hide() is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.hide();
				handle.focus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(handle.isFocused()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() when overlay does not have focus is a no-op", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				handle.unfocus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(overlay.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("unfocus() with null preFocus clears focus and does not route input back to overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				expect(overlay.focused).toBe(true);
				handle.unfocus();
				expect(overlay.focused).toBe(false);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual([]);
				expect(handle.isFocused()).toBe(false);
			} finally {
				tui.stop();
			}
		});
	});

	describe("focus cycle prevention", () => {
		it("toggle focus between non-capturing overlays then unfocus returns to editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a, { nonCapturing: true });
				const bHandle = tui.showOverlay(b, { nonCapturing: true });
				aHandle.focus();
				bHandle.focus();
				aHandle.focus();
				aHandle.unfocus();
				await renderAndFlush(tui, terminal);
				expect(editor.focused).toBe(true);
				expect(a.focused).toBe(false);
				expect(b.focused).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("explicit unfocus target supports cycling between three overlays and editor", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			const c = new FocusableOverlay(["C"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a);
				const bHandle = tui.showOverlay(b);
				const cHandle = tui.showOverlay(c);

				aHandle.focus();
				terminal.sendInput("a");
				await renderAndFlush(tui, terminal);
				bHandle.focus();
				terminal.sendInput("b");
				await renderAndFlush(tui, terminal);
				cHandle.focus();
				terminal.sendInput("c");
				await renderAndFlush(tui, terminal);
				cHandle.unfocus({ target: editor });
				terminal.sendInput("e");
				await renderAndFlush(tui, terminal);
				aHandle.focus();
				terminal.sendInput("A");
				await renderAndFlush(tui, terminal);
				aHandle.unfocus({ target: editor });
				terminal.sendInput("E");
				await renderAndFlush(tui, terminal);

				expect(a.inputs).toStrictEqual(["a", "A"]);
				expect(b.inputs).toStrictEqual(["b"]);
				expect(c.inputs).toStrictEqual(["c"]);
				expect(editor.inputs).toStrictEqual(["e", "E"]);
				expect(editor.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("explicit null unfocus target clears focus without restoring overlays", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const overlay = new FocusableOverlay(["OVERLAY"]);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const handle = tui.showOverlay(overlay);
				handle.unfocus({ target: null });
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(overlay.inputs).toStrictEqual([]);
				expect(handle.isFocused()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("hiding focused overlay falls back to next visual-frontmost overlay", async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			const a = new FocusableOverlay(["A"]);
			const b = new FocusableOverlay(["B"]);
			const c = new FocusableOverlay(["C"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(a);
				const bHandle = tui.showOverlay(b);
				tui.showOverlay(c);
				aHandle.focus();
				bHandle.focus();
				bHandle.setHidden(true);
				terminal.sendInput("x");
				await renderAndFlush(tui, terminal);
				expect(a.inputs).toStrictEqual(["x"]);
				expect(c.inputs).toStrictEqual([]);
				expect(a.focused).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});

	describe("rendering order", () => {
		it("focus() on already-focused overlay bumps visual order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const aHandle = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				aHandle.focus();
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("C");
				aHandle.focus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("A");
				expect(aHandle.isFocused()).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("default rendering order for overlapping overlays follows creation order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
			} finally {
				tui.stop();
			}
		});

		it("focus() on lower overlay renders it on top", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				const lower = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
				lower.focus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("A");
			} finally {
				tui.stop();
			}
		});

		it("focusing middle overlay places it on top while preserving others relative order", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const middle = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const top = tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("C");
				middle.focus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
				middle.hide();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("C");
				top.hide();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("A");
			} finally {
				tui.stop();
			}
		});

		it("capturing overlay hidden and shown again renders on top after unhide", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new EmptyContent());
			tui.start();
			try {
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const capturing = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1 });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
				capturing.setHidden(true);
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("C");
				capturing.setHidden(false);
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
			} finally {
				tui.stop();
			}
		});

		it("unfocus() does not change visual order until another overlay is focused", async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			const editor = new FocusableOverlay(["EDITOR"]);
			tui.addChild(new EmptyContent());
			tui.setFocus(editor);
			tui.start();
			try {
				const a = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				const b = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
				a.focus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("A");
				a.unfocus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("A");
				b.focus();
				await renderAndFlush(tui, terminal);
				expect(terminal.getViewport()[0]?.charAt(0)).toBe("B");
			} finally {
				tui.stop();
			}
		});
	});
});
