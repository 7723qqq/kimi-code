/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import assert from "node:assert";
import { expect, beforeEach, describe, it } from "bun:test";
import { matchesKey } from "../src/keys.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence) => {
			emittedSequences.push(sequence);
		});
	});

	// Helper to process data through the buffer
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	// Helper to wait for async operations
	async function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	describe("Regular Characters", () => {
		it("should pass through regular characters immediately", () => {
			processInput("a");
			expect(emittedSequences).toStrictEqual(["a"]);
		});

		it("should pass through multiple regular characters", () => {
			processInput("abc");
			expect(emittedSequences).toStrictEqual(["a", "b", "c"]);
		});

		it("should handle unicode characters", () => {
			processInput("hello 世界");
			expect(emittedSequences).toStrictEqual(["h", "e", "l", "l", "o", " ", "世", "界"]);
		});
	});

	describe("Complete Escape Sequences", () => {
		it("should pass through complete mouse SGR sequences", () => {
			const mouseSeq = "\x1b[<35;20;5m";
			processInput(mouseSeq);
			expect(emittedSequences).toStrictEqual([mouseSeq]);
		});

		it("should pass through complete arrow key sequences", () => {
			const upArrow = "\x1b[A";
			processInput(upArrow);
			expect(emittedSequences).toStrictEqual([upArrow]);
		});

		it("should pass through complete function key sequences", () => {
			const f1 = "\x1b[11~";
			processInput(f1);
			expect(emittedSequences).toStrictEqual([f1]);
		});

		it("should pass through meta key sequences", () => {
			const metaA = "\x1ba";
			processInput(metaA);
			expect(emittedSequences).toStrictEqual([metaA]);
		});

		it("should pass through SS3 sequences", () => {
			const ss3 = "\x1bOA";
			processInput(ss3);
			expect(emittedSequences).toStrictEqual([ss3]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", async () => {
			processInput("\x1b");
			expect(emittedSequences).toStrictEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b");

			processInput("[<35");
			expect(emittedSequences).toStrictEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toStrictEqual(["\x1b[<35;20;5m"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			expect(emittedSequences).toStrictEqual([]);

			processInput("1;");
			expect(emittedSequences).toStrictEqual([]);

			processInput("5H");
			expect(emittedSequences).toStrictEqual(["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			expect(emittedSequences).toStrictEqual(["\x1b[<35;20;5m"]);
		});

		it("should flush incomplete sequence after timeout", async () => {
			processInput("\x1b[<35");
			expect(emittedSequences).toStrictEqual([]);

			// Wait for timeout
			await wait(15);

			expect(emittedSequences).toStrictEqual(["\x1b[<35"]);
		});

		it("should flush a lone ESC as Escape when CR arrives after the timeout", async () => {
			// Legacy-mode Alt+Enter is ESC + CR; when the terminal/transport splits
			// the bytes further apart than the timeout, ESC is flushed alone and the
			// host sees Escape (interrupt) instead of Alt+Enter. This locks in the
			// behavior so the configurable timeout in ProcessTerminal stays honest.
			processInput("\x1b");
			await wait(20); // buffer timeout is 10ms in beforeEach
			processInput("\r");

			expect(emittedSequences).toStrictEqual(["\x1b", "\r"]);
			expect(matchesKey(emittedSequences[0] ?? "", "escape")).toBe(true);
		});

		it("should merge ESC + CR split across chunks within a larger timeout", async () => {
			buffer = new StdinBuffer({ escapeTimeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20); // > 10ms default escapeTimeout, < 100ms configured escapeTimeout
			processInput("\r");

			expect(emittedSequences).toStrictEqual(["\x1b\r"]);
			expect(matchesKey(emittedSequences[0] ?? "", "alt+enter")).toBe(true);
		});

		it("does not apply the sequence timeout to a lone ESC", async () => {
			buffer = new StdinBuffer({ timeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20);
			processInput("\r");

			expect(emittedSequences).toStrictEqual(["\x1b", "\r"]);
			expect(matchesKey(emittedSequences[0] ?? "", "escape")).toBe(true);
		});

		it("keeps fragmented mouse sequences buffered across delayed chunks by default", async () => {
			const delayedBuffer = new StdinBuffer();
			const delayedSequences: string[] = [];
			delayedBuffer.on("data", (sequence) => delayedSequences.push(sequence));

			delayedBuffer.process("\x1b[");
			await wait(20);
			expect(delayedSequences).toStrictEqual([]);
			delayedBuffer.process("<65;48;39M");
			expect(delayedSequences).toStrictEqual(["\x1b[<65;48;39M"]);
			delayedBuffer.destroy();
		});
	});

	describe("Mixed Content", () => {
		it("should handle characters followed by escape sequence", () => {
			processInput("abc\x1b[A");
			expect(emittedSequences).toStrictEqual(["a", "b", "c", "\x1b[A"]);
		});

		it("should handle escape sequence followed by characters", () => {
			processInput("\x1b[Aabc");
			expect(emittedSequences).toStrictEqual(["\x1b[A", "a", "b", "c"]);
		});

		it("should handle multiple complete sequences", () => {
			processInput("\x1b[A\x1b[B\x1b[C");
			expect(emittedSequences).toStrictEqual(["\x1b[A", "\x1b[B", "\x1b[C"]);
		});

		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			expect(emittedSequences).toStrictEqual(["a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toStrictEqual(["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle Kitty CSI u press events", () => {
			// Press 'a' in Kitty protocol
			processInput("\x1b[97u");
			expect(emittedSequences).toStrictEqual(["\x1b[97u"]);
		});

		it("should handle Kitty CSI u release events", () => {
			// Release 'a' in Kitty protocol
			processInput("\x1b[97;1:3u");
			expect(emittedSequences).toStrictEqual(["\x1b[97;1:3u"]);
		});

		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			expect(emittedSequences).toStrictEqual(["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			expect(emittedSequences).toStrictEqual(["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty arrow keys with event type", () => {
			// Up arrow press with event type
			processInput("\x1b[1;1:1A");
			expect(emittedSequences).toStrictEqual(["\x1b[1;1:1A"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			processInput("\x1b[3;1:3~");
			expect(emittedSequences).toStrictEqual(["\x1b[3;1:3~"]);
		});

		it("should split ESC+ESC+CSI into standalone ESC and the CSI sequence (WezTerm Escape key regression)", () => {
			// WezTerm with enable_kitty_keyboard sends Escape key press as raw \x1b
			// and the release as a full Kitty CSI-u sequence, concatenated.
			// The buffer must not treat \x1b\x1b as a complete meta-key when the
			// following byte starts a new escape sequence.
			processInput("\x1b\x1b[27;129:3u");
			expect(emittedSequences).toStrictEqual(["\x1b", "\x1b[27;129:3u"]);
		});

		it("should split ESC+ESC+CSI with no modifier (no num_lock)", () => {
			processInput("\x1b\x1b[27;1:3u");
			expect(emittedSequences).toStrictEqual(["\x1b", "\x1b[27;1:3u"]);
		});

		it("should still emit ESC+ESC as a single sequence when not followed by a new escape", () => {
			// \x1b\x1b alone (no following CSI) stays as-is — e.g. ctrl+alt+[
			processInput("\x1b\x1b");
			expect(emittedSequences).toStrictEqual(["\x1b\x1b"]);
		});

		it("should handle plain characters mixed with Kitty sequences", () => {
			// Plain 'a' followed by Kitty release
			processInput("a\x1b[97;1:3u");
			expect(emittedSequences).toStrictEqual(["a", "\x1b[97;1:3u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence", () => {
			processInput("\x1b[224uà");
			expect(emittedSequences).toStrictEqual(["\x1b[224u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence across chunks", () => {
			processInput("\x1b[64u");
			processInput("@");
			expect(emittedSequences).toStrictEqual(["\x1b[64u"]);
		});

		it("should keep non-matching plain character after Kitty printable sequence", () => {
			processInput("\x1b[97ub");
			expect(emittedSequences).toStrictEqual(["\x1b[97u", "b"]);
		});

		it("should keep raw character after modified Kitty printable sequence", () => {
			processInput("\x1b[64;3u@");
			expect(emittedSequences).toStrictEqual(["\x1b[64;3u", "@"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			expect(emittedSequences).toStrictEqual(["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			expect(emittedSequences).toStrictEqual(["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			expect(emittedSequences).toStrictEqual(["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			expect(emittedSequences).toStrictEqual(["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			expect(emittedSequences).toStrictEqual(["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			expect(emittedSequences).toStrictEqual(["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			expect(emittedSequences).toStrictEqual(["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			expect(buffer.getBuffer()).toBe("\x1b[M");

			processInput(" a");
			expect(buffer.getBuffer()).toBe("\x1b[M a");

			processInput("b");
			expect(emittedSequences).toStrictEqual(["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// Empty string emits an empty data event
			expect(emittedSequences).toStrictEqual([""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			expect(emittedSequences).toStrictEqual([]);

			// After timeout, should emit
			await wait(15);
			expect(emittedSequences).toStrictEqual(["\x1b"]);
		});

		it("flushes a lone escape promptly with the longer default sequence timeout", async () => {
			const defaultBuffer = new StdinBuffer();
			const defaultSequences: string[] = [];
			defaultBuffer.on("data", (sequence) => defaultSequences.push(sequence));

			defaultBuffer.process("\x1b");
			await wait(20);
			expect(defaultSequences).toStrictEqual(["\x1b"]);
			defaultBuffer.destroy();
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			expect(emittedSequences).toStrictEqual([]);

			const flushed = buffer.flush();
			expect(flushed).toStrictEqual(["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			expect(emittedSequences).toStrictEqual(["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			expect(emittedSequences).toStrictEqual([longSeq]);
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			expect(flushed).toStrictEqual(["\x1b[<35"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			expect(flushed).toStrictEqual([]);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[<35");
			expect(emittedSequences).toStrictEqual([]);

			// Wait for timeout to flush
			await wait(15);

			expect(emittedSequences).toStrictEqual(["\x1b[<35"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.clear();
			expect(buffer.getBuffer()).toBe("");
			expect(emittedSequences).toStrictEqual([]);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			// Collect paste events
			emittedPaste = [];
			buffer.on("paste", (data) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			expect(emittedPaste).toStrictEqual(["hello world"]);
			expect(emittedSequences).toStrictEqual([]); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			expect(emittedPaste).toStrictEqual([]);

			processInput("hello ");
			expect(emittedPaste).toStrictEqual([]);

			processInput("world\x1b[201~");
			expect(emittedPaste).toStrictEqual(["hello world"]);
			expect(emittedSequences).toStrictEqual([]);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			expect(emittedSequences).toStrictEqual(["a", "b"]);
			expect(emittedPaste).toStrictEqual(["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			expect(emittedPaste).toStrictEqual(["line1\nline2\nline3"]);
			expect(emittedSequences).toStrictEqual([]);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello 世界 🎉\x1b[201~");

			expect(emittedPaste).toStrictEqual(["Hello 世界 🎉"]);
			expect(emittedSequences).toStrictEqual([]);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.destroy();
			expect(buffer.getBuffer()).toBe("");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// Wait longer than timeout
			await wait(15);

			// Should not have emitted anything
			expect(emittedSequences).toStrictEqual([]);
		});
	});
});
