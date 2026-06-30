import type { Component } from "../tui.ts";
import type { Terminal } from "../terminal.ts";
import { isImageLine } from "../terminal-image.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findCommittedPrefixResync } from "./audit.ts";
import { getNativeScrollbackCommitSafeEnd, getNativeScrollbackLiveRegionStart, getNativeScrollbackSnapshotSafeEnd, getRenderStablePrefixRows, setNativeScrollbackCommittedRows } from "./seam.ts";
import { coalesceAdjacentSgr } from "./sgr-coalesce.ts";
import { isMultiplexerSession, resizeRepaintsInPlace, shouldEnableSyncOutput, TERMINAL_STUB } from "./terminal-caps-stub.ts";
import {
	type CursorControlResult,
	DISABLE_AUTOWRAP,
	ENABLE_AUTOWRAP,
	ERASE_LINE,
	ERASE_TO_END_OF_LINE,
	type FrameSegment,
	HIDE_CURSOR,
	type HardwareCursorState,
	type HardwareCursorUpdate,
	LINE_TERMINATOR,
	type PreparedLine,
	type RenderIntent,
	SEGMENT_RESET,
	SYNC_OUTPUT_BEGIN,
	SYNC_OUTPUT_END,
} from "./types.ts";

export class LedgerTuiEngine {
	// ---- ledger state (OMP: 990-1028) ----
	#committedRows = 0;
	#committedPrefix: string[] = [];
	#committedPrefixAuditRows = 0;
	#committedPrefixDurableRows = 0;
	#windowTopRow = 0;
	#previousWindow: string[] = [];
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#hardwareCursorRow = 0;
	#showHardwareCursor = process.env["PI_HARDWARE_CURSOR"] !== "0";

	// ---- seam (per-frame, set by compose) ----
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackCommitSafeEnd: number | undefined;
	#nativeScrollbackSnapshotSafeEnd: number | undefined;

	// ---- gesture flags (OMP: 1029-1070) ----
	#fullRedrawCount = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#resizeEventPending = false;

	// ---- composed + prepared caches (OMP: 1087-1125) ----
	#composedFrame: string[] = [];
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	#frameCursorMarkers: { row: number; col: number }[] = [];
	#renderStablePrefixRows = 0;
	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;

	// ---- paint framing ----
	readonly #syncEnabled: boolean;
	readonly #paintBeginSequence: string;
	readonly #paintEndSequence: string;

	// children injected by the host TUI (it owns the Container children list)
	constructor(
		private readonly terminal: Terminal,
		private readonly getChildren: () => Component[],
	) {
		this.#syncEnabled = shouldEnableSyncOutput();
		this.#paintBeginSequence = this.#syncEnabled
			? `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`
			: `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
		this.#paintEndSequence = this.#syncEnabled ? `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}` : ENABLE_AUTOWRAP;
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	// ---- cursor control (OMP: 3647-3671, 3120-3130) ----
	#targetHardwareCursorState(cursorPos: { row: number; col: number } | null, totalLines: number): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}
		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) seq += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) seq += `\x1b[${-rowDelta}A`;
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";
		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		this.#hardwareCursorRow = update.toRow;
		if (update.state) this.#showHardwareCursor = update.state.visible;
	}
}
