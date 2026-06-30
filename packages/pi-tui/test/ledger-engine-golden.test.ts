import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminalCapabilities } from "../src/terminal-capabilities.ts";
import type { ProbeResult } from "../src/terminal-probe.ts";
import { type Component, TUI } from "../src/tui.ts";
import { LoggingVirtualTerminal } from "./virtual-terminal.ts";

const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/**
 * A LoggingVirtualTerminal that exposes the mutable, probe-backed capabilities
 * and a controllable `probeReady` promise, mirroring ProcessTerminal. Resolving
 * the probe applies the result to the shared capabilities first, so the TUI's
 * probe-refresh re-reads the probed values — the same ordering ProcessTerminal
 * guarantees.
 */
class ProbeVirtualTerminal extends LoggingVirtualTerminal {
	readonly terminalCapabilities: ProcessTerminalCapabilities;
	readonly probeReady: Promise<ProbeResult>;
	private resolveProbe: (result: ProbeResult) => void = () => {};

	constructor(columns: number, rows: number, env: NodeJS.ProcessEnv) {
		super(columns, rows);
		this.terminalCapabilities = new ProcessTerminalCapabilities(env);
		this.probeReady = new Promise<ProbeResult>((resolve) => {
			this.resolveProbe = resolve;
		});
	}

	resolveProbeResult(result: ProbeResult): void {
		this.terminalCapabilities.applyProbe(result);
		this.resolveProbe(result);
	}
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

	it("parks cursor past content on stop()", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello", "World"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();
			tui.stop();
			const writes = terminal.getWrites();
			// stop() must emit a cursor-parking sequence ending with CRLF so the host
			// shell prompt lands on a fresh line below the painted content (not
			// overwriting it). This regresses the ledger-path exit artifact.
			assert.ok(
				writes.includes("\r\n"),
				`stop() should park cursor with a trailing CRLF; got: ${JSON.stringify(writes)}`,
			);
		});
	});

	it("re-frames the ledger paint with sync markers after a probe reports synchronized output", async () => {
		await withLedger(async () => {
			// Plain "xterm" is not in the static sync-known list, so capabilities
			// start with syncEnabled=false until the probe says otherwise.
			const terminal = new ProbeVirtualTerminal(40, 8, { TERM: "xterm" });
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello"];
			tui.start();
			await terminal.waitForRender();

			const before = terminal.getWrites();
			assert.ok(
				!before.includes(SYNC_OUTPUT_BEGIN),
				`no sync begin before probe resolves: ${JSON.stringify(before)}`,
			);
			assert.ok(
				!before.includes(SYNC_OUTPUT_END),
				`no sync end before probe resolves: ${JSON.stringify(before)}`,
			);

			terminal.clearWrites();
			// Append a line so the post-probe render is a real diff: the ledger engine
			// skips the paint framing entirely when nothing changed between frames.
			c.lines = ["Hello", "Probed"];
			terminal.resolveProbeResult({
				kittyKeyboard: false,
				syncOutput: true,
				inBandResize: undefined,
				appearancePush: undefined,
				background: undefined,
			});
			await terminal.waitForRender();

			const after = terminal.getWrites();
			assert.ok(
				after.includes(SYNC_OUTPUT_BEGIN),
				`sync begin after probe resolves: ${JSON.stringify(after)}`,
			);
			assert.ok(
				after.includes(SYNC_OUTPUT_END),
				`sync end after probe resolves: ${JSON.stringify(after)}`,
			);
			tui.stop();
		});
	});
});
