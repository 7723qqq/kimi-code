/**
 * Terminal-sequence hygiene for text that originates outside this process:
 * model output, file contents, MCP tool results, user-provided titles.
 *
 * Two concerns, one module:
 *   - text that is *written into* an escape sequence (an OSC 8 URL, an OSC 0
 *     title) must not be able to close the sequence early and inject one of
 *     its own — a control byte inside the payload is the injection;
 *   - text that is *printed as-is* may still carry C0/C1 controls (BEL, CR,
 *     backspace) that make a terminal do things unrelated to display.
 */

/** Control characters that must never reach the terminal as-is. */
const UNSAFE_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
const UNSAFE_CHARS_GLOBAL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** Every C0/C1 byte (tab and newline included) plus DEL. */
const ALL_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * True when `text` contains a control byte that could terminate or extend a
 * terminal escape sequence (BEL, ESC, CR, C1 range, ...). Tab is allowed: it
 * is ordinary layout, not an injection vector.
 */
export function hasUnsafeTerminalChars(text: string): boolean {
  return UNSAFE_CHARS.test(text);
}

/**
 * Replace every unsafe control byte with U+FFFD, keeping printable text
 * intact. Used for payloads that go inside an escape sequence: dropping the
 * characters silently would hide the attempt, and keeping them would let the
 * payload close the sequence.
 */
export function sanitizeTerminalPayload(text: string): string {
  return text.replace(UNSAFE_CHARS_GLOBAL, '\uFFFD');
}

/**
 * Drop every control byte (C0, C1, DEL) and normalise the layout characters a
 * window title cannot carry, so the caller only ever appends the OSC 0
 * terminator it chose. Printable text is preserved verbatim; a title that is
 * empty or all control bytes yields an empty string, and the caller must then
 * write nothing at all.
 */
export function sanitizeTitleParameter(title: string): string {
  return title
    .replace(/[\t\n\r\u00a0]+/g, ' ')
    .replace(ALL_CONTROL_CHARS_GLOBAL, '')
    .trim();
}
