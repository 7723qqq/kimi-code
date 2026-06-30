import { isImageLine as detectImageLine } from "./terminal-image.ts";

export type ImageProtocol = "kitty" | "sixel" | "iterm2" | "none";

export interface TerminalCapabilities {
	readonly syncEnabled: boolean;
	readonly supportsScreenToScrollback: boolean;
	readonly deccara: boolean;
	readonly hyperlinks: boolean;
	readonly imageProtocol: ImageProtocol;
	isImageLine(line: string): boolean;
}

const SYNC_KNOWN = ["xterm-kitty", "xterm-ghostty", "wezterm", "alacritty", "foot", "contour", "kitty", "ghostty"];

// OMP: isMultiplexerSession (388-401) — Bun.env → process.env
export function isMultiplexerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["TMUX"] || env["STY"] || env["ZELLIJ"] || env["CMUX_WORKSPACE_ID"] || env["CMUX_SURFACE_ID"]) return true;
	const term = (env["TERM"] ?? "").toLowerCase();
	return term.startsWith("tmux") || term.startsWith("screen");
}

// OMP: reportsSizeOnAltScreenToggle (415-420)
function reportsSizeOnAltScreenToggle(env: NodeJS.ProcessEnv = process.env): boolean {
	const override = env["PI_TUI_RESIZE_IN_PLACE"];
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return env["TERM_PROGRAM"]?.toLowerCase() === "warpterminal";
}

// OMP: resizeRepaintsInPlace (428-430)
export function resizeRepaintsInPlace(env: NodeJS.ProcessEnv = process.env): boolean {
	return isMultiplexerSession(env) || reportsSizeOnAltScreenToggle(env);
}

export function shouldEnableSyncOutput(env: NodeJS.ProcessEnv = process.env, detected?: boolean): boolean {
	if (env["PI_FORCE_SYNC_OUTPUT"] === "1") return true;
	if (env["PI_NO_SYNC_OUTPUT"] === "1") return false;
	if (typeof detected === "boolean") return detected; // DECRQM runtime result wins
	if (isMultiplexerSession(env)) return false;
	const term = env["TERM"] ?? "";
	return SYNC_KNOWN.some((k) => term.includes(k));
}

export function shouldEnableHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["PI_NO_HYPERLINKS"] === "1") return false;
	if (isMultiplexerSession(env)) return false;
	return true;
}

/**
 * Static default terminal capabilities, derived purely from environment
 * inspection. Used by the host TUI before any runtime probing (DA1 / DECRQM)
 * exists; Task 2 will swap this for a probe-backed instance.
 */
export function createStaticCapabilities(env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
	return {
		syncEnabled: shouldEnableSyncOutput(env),
		supportsScreenToScrollback: false,
		deccara: false,
		hyperlinks: shouldEnableHyperlinks(env),
		imageProtocol: "none",
		isImageLine: detectImageLine,
	};
}
