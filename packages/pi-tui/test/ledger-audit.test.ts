import assert from "node:assert";
import { describe, it } from "node:test";
import { findCommittedPrefixResync } from "../src/ledger/audit.ts";

describe("findCommittedPrefixResync", () => {
	it("returns -1 when frame matches prefix", () => {
		const prefix = ["a", "b", "c"];
		assert.strictEqual(findCommittedPrefixResync(["a", "b", "c"], prefix), -1);
	});
	it("returns -1 for a single in-place edit within tolerance", () => {
		const prefix = ["a", "b", "c", "d"];
		// one-row edit in the tail sample window → tolerated
		assert.strictEqual(findCommittedPrefixResync(["a", "b", "X", "d"], prefix), -1);
	});
	it("re-anchors at first shifted row on insertion", () => {
		const prefix = ["a", "b", "c", "d"];
		// insertion shifts everything below row 1
		const frame = ["a", "INS", "b", "c", "d"];
		assert.strictEqual(findCommittedPrefixResync(frame, prefix), 1);
	});
	it("re-anchors when frame no longer covers prefix", () => {
		const prefix = ["a", "b", "c", "d"];
		assert.strictEqual(findCommittedPrefixResync(["a", "b"], prefix), 2);
	});
	it("skips the exempt window", () => {
		const prefix = ["a", "b", "c", "d"];
		// row 1-2 differ but are exempt
		const frame = ["a", "X", "Y", "d"];
		assert.strictEqual(findCommittedPrefixResync(frame, prefix, 4, 1, 3), -1);
	});
	it("hard scan catches a finalized forced-row change", () => {
		const prefix = ["a", "b", "c", "d"];
		// permanentEnd=4 with an empty exempt window forces a full hard scan over [0,4); row 1 changed → re-anchor at 1
		assert.strictEqual(findCommittedPrefixResync(["a", "Z", "c", "d"], prefix, 4, 0, 0, 4), 1);
	});
	it("treats SGR-only differences as equivalent", () => {
		const prefix = ["\x1b[31mhello\x1b[0m"];
		assert.strictEqual(findCommittedPrefixResync(["\x1b[32mhello\x1b[0m"], prefix), -1);
	});
});
