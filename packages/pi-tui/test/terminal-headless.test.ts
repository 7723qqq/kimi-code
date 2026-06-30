import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal, setTerminalHeadless } from "../src/terminal.ts";

describe("ProcessTerminal headless", () => {
	it("does not write probes or frames when headless", () => {
		setTerminalHeadless(true);
		try {
			const term = new ProcessTerminal();
			const writes: string[] = [];
			const orig = process.stdout.write;
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
			(process.stdout as unknown as { write: typeof orig }).write = orig;
			assert.strictEqual(writes.length, 0, `headless must not write: ${writes.join("|")}`);
		} finally {
			setTerminalHeadless(undefined);
		}
	});
});
