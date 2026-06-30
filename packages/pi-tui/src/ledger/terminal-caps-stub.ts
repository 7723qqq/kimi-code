// OMP: isMultiplexerSession (388-401) — Bun.env → process.env
export function isMultiplexerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["TMUX"] || env["STY"] || env["ZELLIJ"]) return true;
	if (env["CMUX_WORKSPACE_ID"] || env["CMUX_SURFACE_ID"]) return true;
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

// 同步输出门控（简化版；完整 DECRQM 探测留给 Phase B）
const SYNC_KNOWN = ["xterm-kitty", "xterm-ghostty", "wezterm", "alacritty", "foot", "contour", "kitty", "ghostty"];
export function shouldEnableSyncOutput(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["PI_FORCE_SYNC_OUTPUT"] === "1") return true;
	if (env["PI_NO_SYNC_OUTPUT"] === "1") return false;
	if (isMultiplexerSession(env)) return false;
	const term = env["TERM"] ?? "";
	return SYNC_KNOWN.some((k) => term.includes(k));
}

// 能力桩：Phase A 不用 kitty ED22 / deccara；isImageLine 由 engine 注入
export const TERMINAL_STUB = {
	supportsScreenToScrollback: false,
	deccara: false,
};
