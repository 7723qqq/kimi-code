import { expect, describe, it } from "bun:test";

import {
	hasUnsafeTerminalChars,
	sanitizeTerminalPayload,
} from "../src/terminal-sanitize.ts";

describe("terminal-sanitize", () => {
	it("detects control bytes that can escape an OSC payload", () => {
		expect(hasUnsafeTerminalChars("https://example.com")).toBe(false);
		expect(hasUnsafeTerminalChars("https://example.com/a b")).toBe(false);
		expect(hasUnsafeTerminalChars("https://example.com/a\tb")).toBe(false);
		expect(hasUnsafeTerminalChars("https://example.com\u0007")).toBe(true);
		expect(hasUnsafeTerminalChars("https://example.com\u001b]2;x\u0007")).toBe(true);
		expect(hasUnsafeTerminalChars("https://example.com\r\n")).toBe(true);
		expect(hasUnsafeTerminalChars("x\u009b")).toBe(true);
	});

	it("replaces unsafe bytes instead of dropping them", () => {
		expect(sanitizeTerminalPayload("https://example.com\u0007evil")).toBe("https://example.com\uFFFDevil");
		expect(sanitizeTerminalPayload("title\u001b]2;pwned\u0007")).toBe("title\uFFFD]2;pwned\uFFFD");
	});

	it("leaves ordinary printable text untouched", () => {
		const text = "Deploy summary — 5 files, 你好, 100%";
		expect(sanitizeTerminalPayload(text)).toBe(text);
	});
});

describe("terminal escape payloads", () => {
	it("hyperlink() neutralizes control bytes in the URL", async () => {
		const { hyperlink } = await import("../src/terminal-image.ts");
		const rendered = hyperlink("click", "https://example.com\u001b]2;pwned\u0007");
		const payload = rendered.slice("\x1b]8;;".length, rendered.indexOf("\x1b\\"));
		expect(!payload.includes("\u001b"), "URL must not carry a raw ESC").toBeTruthy();
		expect(!payload.includes("\u0007"), "URL must not carry a raw BEL").toBeTruthy();
		expect(rendered).toBe("\x1b]8;;https://example.com\uFFFD]2;pwned\uFFFD\x1b\\click\x1b]8;;\x1b\\");
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
			expect(titleWrite !== undefined, "setTitle writes an OSC 0 sequence").toBeTruthy();
			expect(titleWrite).toBe("\x1b]0;session]2;pwned\x07");
			expect(!/[\u0000-\u0008\u000a-\u001f]/.test(titleWrite.slice(4, -1)), "the title payload carries no raw control byte").toBeTruthy();
		} finally {
			(process.stdout as unknown as { write: typeof original }).write = original;
		}
	});
});
