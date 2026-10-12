import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	hasUnsafeTerminalChars,
	sanitizeTerminalPayload,
} from "../src/terminal-sanitize.ts";

describe("terminal-sanitize", () => {
	it("detects control bytes that can escape an OSC payload", () => {
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com"), false);
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com/a b"), false);
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com/a\tb"), false);
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com\u0007"), true);
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com\u001b]2;x\u0007"), true);
		assert.strictEqual(hasUnsafeTerminalChars("https://example.com\r\n"), true);
		assert.strictEqual(hasUnsafeTerminalChars("x\u009b"), true);
	});

	it("replaces unsafe bytes instead of dropping them", () => {
		assert.strictEqual(
			sanitizeTerminalPayload("https://example.com\u0007evil"),
			"https://example.com\uFFFDevil",
		);
		assert.strictEqual(
			sanitizeTerminalPayload("title\u001b]2;pwned\u0007"),
			"title\uFFFD]2;pwned\uFFFD",
		);
	});

	it("leaves ordinary printable text untouched", () => {
		const text = "Deploy summary — 5 files, 你好, 100%";
		assert.strictEqual(sanitizeTerminalPayload(text), text);
	});
});

describe("terminal escape payloads", () => {
	it("hyperlink() neutralizes control bytes in the URL", async () => {
		const { hyperlink } = await import("../src/terminal-image.ts");
		const rendered = hyperlink("click", "https://example.com\u001b]2;pwned\u0007");
		const payload = rendered.slice("\x1b]8;;".length, rendered.indexOf("\x1b\\"));
		assert.ok(!payload.includes("\u001b"), "URL must not carry a raw ESC");
		assert.ok(!payload.includes("\u0007"), "URL must not carry a raw BEL");
		assert.strictEqual(
			rendered,
			"\x1b]8;;https://example.com\uFFFD]2;pwned\uFFFD\x1b\\click\x1b]8;;\x1b\\",
		);
	});

	it("setTitle() writes a sanitized OSC 0 sequence", async () => {
		const { ProcessTerminal } = await import("../src/terminal.ts");
		const writes: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		(process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
			chunk: string,
		) => {
			writes.push(String(chunk));
			return true;
		};
		try {
			const terminal = new ProcessTerminal();
			terminal.setTitle("session\u0007\u001b]2;pwned");
			const titleWrite = writes.find((chunk) => chunk.startsWith("\x1b]0;"));
			assert.ok(titleWrite !== undefined, "setTitle writes an OSC 0 sequence");
			assert.strictEqual(titleWrite, "\x1b]0;session\uFFFD\uFFFD]2;pwned\u0007");
			assert.ok(
				!/[\u0000-\u0008\u000a-\u001f]/.test(titleWrite.slice(4, -1)),
				"the title payload carries no raw control byte",
			);
		} finally {
			(process.stdout as unknown as { write: typeof original }).write = original;
		}
	});
});
