import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal, setTerminalHeadless } from "../src/terminal.ts";

describe("ProcessTerminal headless", () => {
	it("does not write probes or frames when headless", () => {
		setTerminalHeadless(true);
		const writes: string[] = [];
		const orig = process.stdout.write;
		try {
			const term = new ProcessTerminal();
			(process.stdout as unknown as { write: (d: string) => boolean }).write = (d: string) => {
				writes.push(d);
				return true;
			};
			term.start(
				() => {},
				() => {},
			);
			term.write("\x1b[?2026h");
			term.stop();
			assert.strictEqual(writes.length, 0, `headless must not write: ${writes.join("|")}`);
		} finally {
			// Restore stdout.write even if start/write/stop/assert throws, so a
			// failure here cannot leak the monkeypatch into later tests.
			(process.stdout as unknown as { write: typeof orig }).write = orig;
			setTerminalHeadless(undefined);
		}
	});
});
