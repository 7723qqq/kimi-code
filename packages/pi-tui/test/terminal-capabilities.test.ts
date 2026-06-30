import assert from "node:assert";
import { describe, it } from "node:test";
import { isMultiplexerSession, shouldEnableHyperlinks, shouldEnableSyncOutput } from "../src/terminal-capabilities.ts";

describe("terminal-capabilities", () => {
	it("detects mux via env and TERM fallback", () => {
		assert.strictEqual(isMultiplexerSession({ TMUX: "x" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "screen-256color" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "xterm-256color" }), false);
	});
	it("sync: force on overrides mux", () => {
		assert.strictEqual(shouldEnableSyncOutput({ PI_FORCE_SYNC_OUTPUT: "1", TMUX: "x" }), true);
	});
	it("sync: off in mux by default", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TMUX: "x", TERM: "xterm-kitty" }), false);
	});
	it("sync: on for known direct terminal", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }), true);
	});
	it("sync: DECRQM result overrides static table", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "dumb" }, true), true);
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }, false), false);
	});
	it("hyperlinks off in mux", () => {
		assert.strictEqual(shouldEnableHyperlinks({ TMUX: "x" }), false);
	});
});
