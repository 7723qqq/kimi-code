import type { Component } from "../tui.ts";

export const SEGMENT_RESET = "\x1b[0m";
export const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
export const ERASE_LINE = "\x1b[2K";
export const ERASE_TO_END_OF_LINE = "\x1b[K";
export const HIDE_CURSOR = "\x1b[?25l";
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
export const DISABLE_AUTOWRAP = "\x1b[?7l";
export const ENABLE_AUTOWRAP = "\x1b[?7h";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_EXIT = "\x1b[?1049l";

export const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;
export const MERGE_TOKEN_CAP = 16;

export type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

export interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

export interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

export interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

export interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	liveLocalStart?: number;
	commitLocalEnd?: number;
	snapshotLocalEnd?: number;
}

export interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}
