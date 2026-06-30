import assert from "node:assert";
import { describe, it } from "node:test";
import { type ProbeIO, probeCapabilities } from "../src/terminal-probe.ts";

class FakeProbeIO implements ProbeIO {
	written: string[] = [];
	private listeners = new Set<(data: string) => void>();

	write(data: string): void {
		this.written.push(data);
	}

	onReply(cb: (data: string) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	emit(data: string): void {
		for (const cb of this.listeners) {
			cb(data);
		}
	}
}

const DA1 = "\x1b[?1;2c";
const KITTY = "\x1b[?0u";
const OSC11 = "\x1b]11;rgb:1e1e/1e1e/2e2e\x07"; // ≈ { r: 30, g: 30, b: 46 }
const DECRPM_2026_SET = "\x1b[?2026;1$y";
const DECRPM_2048_SET = "\x1b[?2048;1$y";
const DECRPM_2031_SET = "\x1b[?2031;1$y";

describe("probeCapabilities", () => {
	it("resolves every probe in order when the terminal supports everything", async () => {
		const io = new FakeProbeIO();
		const promise = probeCapabilities(io, { timeoutMs: 50 });

		io.emit(KITTY);
		io.emit(DA1);
		io.emit(OSC11);
		io.emit(DA1);
		io.emit(DECRPM_2026_SET);
		io.emit(DA1);
		io.emit(DECRPM_2048_SET);
		io.emit(DA1);
		io.emit(DECRPM_2031_SET);
		io.emit(DA1);

		const result = await promise;

		// Write order: kitty → OSC 11 → DECRQM 2026 → 2048 → 2031, each fused with its DA1 sentinel.
		assert.deepStrictEqual(io.written, [
			"\x1b[?u\x1b[c",
			"\x1b]11;?\x07\x1b[c",
			"\x1b[?2026$p\x1b[c",
			"\x1b[?2048$p\x1b[c",
			"\x1b[?2031$p\x1b[c",
		]);
		for (const write of io.written) {
			assert.ok(write.endsWith("\x1b[c"), `probe write must end with DA1 sentinel: ${JSON.stringify(write)}`);
		}

		assert.strictEqual(result.kittyKeyboard, true);
		assert.deepStrictEqual(result.background, { r: 30, g: 30, b: 46 });
		assert.strictEqual(result.syncOutput, true);
		assert.strictEqual(result.inBandResize, true);
		assert.strictEqual(result.appearancePush, true);
	});

	it("resolves an ignored probe via its DA1 sentinel, not the timeout", async () => {
		const io = new FakeProbeIO();
		const promise = probeCapabilities(io, { timeoutMs: 50 });

		// Kitty supported.
		io.emit(KITTY);
		io.emit(DA1);
		// OSC 11 ignored: only its DA1 sentinel arrives, no OSC 11 reply.
		io.emit(DA1);
		// Remaining DECRQM probes resolve normally.
		io.emit(DECRPM_2026_SET);
		io.emit(DA1);
		io.emit(DECRPM_2048_SET);
		io.emit(DA1);
		io.emit(DECRPM_2031_SET);
		io.emit(DA1);

		const result = await promise;

		assert.strictEqual(result.kittyKeyboard, true);
		assert.strictEqual(result.background, undefined); // DA1 beat the OSC 11 reply
		assert.strictEqual(result.syncOutput, true);
		assert.strictEqual(result.inBandResize, true);
		assert.strictEqual(result.appearancePush, true);
	});

	it("hits the hard ceiling and resolves inconclusive when nothing replies", async () => {
		const io = new FakeProbeIO();
		const start = Date.now();
		const result = await probeCapabilities(io, { timeoutMs: 50 });
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 1000, `probe should resolve near the timeout ceiling, took ${elapsed}ms`);
		assert.strictEqual(result.kittyKeyboard, false);
		assert.strictEqual(result.syncOutput, undefined);
		assert.strictEqual(result.inBandResize, undefined);
		assert.strictEqual(result.appearancePush, undefined);
		assert.strictEqual(result.background, undefined);
	});

	it("ignores a late DECRPM that arrives after its DA1 sentinel (FIFO idempotency)", async () => {
		const io = new FakeProbeIO();
		const promise = probeCapabilities(io, { timeoutMs: 50 });

		io.emit(KITTY);
		io.emit(DA1);
		io.emit(OSC11);
		io.emit(DA1);
		io.emit(DECRPM_2026_SET);
		io.emit(DA1);
		// ?2048 DA1 arrives BEFORE its DECRPM — the sentinel resolves 2048 as inconclusive.
		io.emit(DA1);
		// Late DECRPM for 2048 must NOT override the earlier DA1 resolution.
		io.emit(DECRPM_2048_SET);
		io.emit(DECRPM_2031_SET);
		io.emit(DA1);

		const result = await promise;

		assert.strictEqual(result.inBandResize, undefined); // first result (DA1) wins
		assert.strictEqual(result.kittyKeyboard, true);
		assert.deepStrictEqual(result.background, { r: 30, g: 30, b: 46 });
		assert.strictEqual(result.syncOutput, true);
		assert.strictEqual(result.appearancePush, true);
	});

	it("reassembles probe replies split across chunks", async () => {
		const io = new FakeProbeIO();
		const promise = probeCapabilities(io, { timeoutMs: 50 });

		// Kitty reply split in two.
		io.emit("\x1b[?0");
		io.emit("u");
		io.emit(DA1);
		// OSC 11 reply split across three chunks.
		io.emit("\x1b]11;rgb:1e1e/");
		io.emit("1e1e/2e2e");
		io.emit("\x07");
		io.emit(DA1);
		io.emit(DECRPM_2026_SET);
		io.emit(DA1);
		io.emit(DECRPM_2048_SET);
		io.emit(DA1);
		io.emit(DECRPM_2031_SET);
		io.emit(DA1);

		const result = await promise;

		assert.strictEqual(result.kittyKeyboard, true);
		assert.deepStrictEqual(result.background, { r: 30, g: 30, b: 46 });
		assert.strictEqual(result.syncOutput, true);
		assert.strictEqual(result.inBandResize, true);
		assert.strictEqual(result.appearancePush, true);
	});

	it("maps DECRQM status to the three-way result", async () => {
		const cases: Array<[string, boolean | undefined]> = [
			["\x1b[?2026;0$y", false], // not recognized
			["\x1b[?2026;1$y", true], // set
			["\x1b[?2026;2$y", true], // reset
			["\x1b[?2026;3$y", true], // permanently set
			["\x1b[?2026;4$y", false], // permanently reset
		];
		for (const [reply, expected] of cases) {
			const io = new FakeProbeIO();
			const promise = probeCapabilities(io, { timeoutMs: 50 });
			io.emit(KITTY);
			io.emit(DA1);
			io.emit(OSC11);
			io.emit(DA1);
			io.emit(reply); // the 2026 DECRPM under test
			io.emit(DA1);
			io.emit(DECRPM_2048_SET);
			io.emit(DA1);
			io.emit(DECRPM_2031_SET);
			io.emit(DA1);
			const result = await promise;
			assert.strictEqual(result.syncOutput, expected, `DECRPM ${JSON.stringify(reply)}`);
		}
	});
});
