const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

function decodeReencodedCtrlByte(match: string, code: string): string {
	const cp = Number(code);
	if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96); // a-z → Ctrl+A..Ctrl+Z
	if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64); // A-Z → Ctrl+A..Ctrl+Z
	return match;
}

/**
 * Decode tmux's re-encoded control bytes (both `extended-keys-format` variants) inside a
 * bracketed-paste payload back to their literal byte (e.g. Ctrl+J → "\n"). Leaves the rest of
 * the text untouched. Call before any control-character stripping so newlines/tabs survive
 * instead of leaking the printable escape tail into the buffer.
 */
export function decodeReencodedPasteControls(text: string): string {
	return text
		.replace(REENCODED_CTRL_CSI_U, decodeReencodedCtrlByte)
		.replace(REENCODED_CTRL_XTERM, decodeReencodedCtrlByte);
}
