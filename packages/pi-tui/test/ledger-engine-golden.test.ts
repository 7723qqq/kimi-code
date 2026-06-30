import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { LoggingVirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prev = process.env["PI_TUI_ENGINE"];
	process.env["PI_TUI_ENGINE"] = "ledger";
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prev;
	}
}

describe("ledger engine golden", () => {
	it("renders basic content", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello", "World"];
			tui.start();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("Hello"));
			assert.ok(v[1]?.includes("World"));
			tui.stop();
		});
	});

	it("commits appended rows and repaints window on streaming append", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["L0", "L1", "L2"];
			tui.start();
			await terminal.waitForRender();
			// append beyond viewport
			for (let i = 3; i < 12; i++) {
				c.lines = [...c.lines, `L${i}`];
				tui.requestRender();
				await terminal.waitForRender();
			}
			const v = terminal.getViewport();
			assert.ok(v.join("\n").includes("L11"), `tail visible: ${v.join("|")}`);
			tui.stop();
		});
	});

	it("clamps over-wide lines instead of throwing", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(10, 4);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["1234567890ABCDEF"];
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("1234567890"));
			c.lines = ["ok"];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("ok"));
			tui.stop();
		});
	});

	it("handles content shrink", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["a", "b", "c", "d"];
			tui.start();
			await terminal.waitForRender();
			c.lines = ["a", "b"];
			tui.requestRender();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("a"));
			assert.ok(v[1]?.includes("b"));
			tui.stop();
		});
	});
});
