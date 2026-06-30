import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("StdinBuffer partial-hold + paste watchdog", () => {
	let buffer: StdinBuffer;
	let emittedData: string[];
	let emittedPaste: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		buffer = new StdinBuffer({ timeout: 5, partialHoldTimeout: 50, pasteTimeout: 100 });
		emittedData = [];
		emittedPaste = [];
		buffer.on("data", (sequence) => {
			emittedData.push(sequence);
		});
		buffer.on("paste", (data) => {
			emittedPaste.push(data);
		});
	});

	afterEach(() => {
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	it("joins a split SGR mouse report into one sequence with no leak", () => {
		buffer.process("\x1b[<35;8;16");
		buffer.process("M");

		assert.deepStrictEqual(emittedData, ["\x1b[<35;8;16M"]);
		// No ESC-less fragment leaked as typed text; the single emission is the full sequence.
		assert.ok(emittedData.every((sequence) => sequence.startsWith("\x1b")));
	});

	it("holds a dangling ESC[ under kitty until the hold ceiling, then flushes raw", async () => {
		setKittyProtocolActive(true);
		buffer.process("\x1b[");

		// Past the per-timer timeout (5ms) but before the hold ceiling (50ms):
		// the partial is re-armed, so nothing is emitted yet.
		await wait(20);
		assert.deepStrictEqual(emittedData, []);

		// Past the hold ceiling: the stale partial is delivered raw.
		await wait(120);
		assert.deepStrictEqual(emittedData, ["\x1b["]);
	});

	it("does not hold a dangling ESC[ when kitty is inactive", async () => {
		setKittyProtocolActive(false);
		buffer.process("\x1b[");

		// Flushed at the normal timeoutMs (5ms), well before the 50ms hold ceiling.
		await wait(30);
		assert.deepStrictEqual(emittedData, ["\x1b["]);
	});

	it("holds an SGR mouse prefix even without kitty", async () => {
		setKittyProtocolActive(false);
		buffer.process("\x1b[<35");

		// Past timeoutMs (5ms) but before the hold ceiling (50ms): still held.
		await wait(20);
		assert.deepStrictEqual(emittedData, []);

		// Past the hold ceiling: flushed raw.
		await wait(120);
		assert.deepStrictEqual(emittedData, ["\x1b[<35"]);
	});

	it("aborts a stalled paste after the inactivity watchdog and recovers input", async () => {
		buffer.process("\x1b[200~hello");
		assert.deepStrictEqual(emittedPaste, []);

		// Advance past the paste inactivity timeout (100ms) so the watchdog aborts.
		await wait(180);
		assert.deepStrictEqual(emittedPaste, ["hello"]);

		// Input recovers: subsequent data is parsed as normal keystrokes.
		buffer.process("x");
		assert.deepStrictEqual(emittedData, ["x"]);
	});

	it("aborts a paste synchronously when the byte cap is exceeded", () => {
		buffer.destroy();
		buffer = new StdinBuffer({ timeout: 5, pasteByteLimit: 8 });
		emittedData = [];
		emittedPaste = [];
		buffer.on("data", (sequence) => {
			emittedData.push(sequence);
		});
		buffer.on("paste", (data) => {
			emittedPaste.push(data);
		});

		buffer.process("\x1b[200~");
		buffer.process("0123456789abcdef");

		// Aborted synchronously inside process(); no inactivity timer involved.
		assert.deepStrictEqual(emittedPaste, ["0123456789abcdef"]);
	});

	it("completes a normal paste and parses trailing data", () => {
		buffer.process("\x1b[200~hello\x1b[201~world");

		assert.deepStrictEqual(emittedPaste, ["hello"]);
		assert.strictEqual(emittedData.join(""), "world");
	});

	it("detects a paste end marker split across two chunks via the overlap tail", () => {
		buffer.process("\x1b[200~hello\x1b[201");
		assert.deepStrictEqual(emittedPaste, []);

		buffer.process("~world");

		assert.deepStrictEqual(emittedPaste, ["hello"]);
		assert.strictEqual(emittedData.join(""), "world");
	});
});
