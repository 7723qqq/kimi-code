import assert from "node:assert";
import { describe, it } from "node:test";
import { decodeReencodedPasteControls } from "../src/bracketed-paste.ts";

describe("decodeReencodedPasteControls", () => {
	it("decodes csi-u Ctrl+J", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[106;5u"), "\n");
	});
	it("decodes xterm modifyOtherKeys Ctrl+J", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[27;5;106~"), "\n");
	});
	it("leaves plain text unchanged", () => {
		assert.strictEqual(decodeReencodedPasteControls("hello world"), "hello world");
	});
	it("decodes Ctrl+I (TAB) and Ctrl+M (CR)", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[105;5u"), "\t");
		assert.strictEqual(decodeReencodedPasteControls("\x1b[109;5u"), "\r");
	});
	it("decodes both variants in one payload", () => {
		assert.strictEqual(decodeReencodedPasteControls("a\x1b[106;5ub\x1b[27;5;106~c"), "a\nb\nc");
	});
	it("leaves non-letter codepoints untouched", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[27;5u"), "\x1b[27;5u");
	});
});
