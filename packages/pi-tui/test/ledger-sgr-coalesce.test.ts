import assert from "node:assert";
import { describe, it } from "node:test";
import { coalesceAdjacentSgr } from "../src/ledger/sgr-coalesce.ts";

describe("coalesceAdjacentSgr (ledger)", () => {
	it("merges byte-adjacent SGR into one CSI", () => {
		assert.strictEqual(coalesceAdjacentSgr("\x1b[39m\x1b[38;2;1;2;3mX"), "\x1b[39;38;2;1;2;3mX");
	});
	it("keeps non-adjacent SGR separate", () => {
		assert.strictEqual(coalesceAdjacentSgr("\x1b[31mA\x1b[32mB"), "\x1b[31mA\x1b[32mB");
	});
	it("splits runs over the 16-token cap", () => {
		const run = Array.from({ length: 20 }, () => "\x1b[1m").join("");
		const out = coalesceAdjacentSgr(`${run}X`);
		assert.ok((out.match(/\x1b\[/g) ?? []).length >= 2);
	});
	it("does not merge across incomplete extended color", () => {
		const out = coalesceAdjacentSgr("\x1b[38;2m\x1b[1mX");
		assert.ok(out.includes("\x1b[38;2m\x1b[1m"), JSON.stringify(out));
	});
	it("returns plain text unchanged (same reference not required)", () => {
		assert.strictEqual(coalesceAdjacentSgr("hello"), "hello");
	});
});
