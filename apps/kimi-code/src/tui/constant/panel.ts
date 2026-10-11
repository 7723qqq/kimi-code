/**
 * Glyphs and spacing for the canonical panel frame.
 *
 * The frame is the one box language for panels in the transcript and the
 * status strip (drawn by `components/chrome/panel-frame.ts`):
 *
 *     ╭ Title ────╮
 *     │ content  │
 *     ╰──────────╯
 *
 * Transcript panels indent the box's left edge by {@link PANEL_INDENT} so it
 * lines up with message body text; panels inside the status strip pass
 * `indent: 0` and start at column 0 of their region.
 */

// Corners and edges. `─`/`│` are drawn as a continuous run; the corners close
// the run so every row is exactly one cell wider than the content.
export const PANEL_TOP_LEFT = '╭';
export const PANEL_TOP_RIGHT = '╮';
export const PANEL_BOTTOM_LEFT = '╰';
export const PANEL_BOTTOM_RIGHT = '╯';
export const PANEL_HORIZONTAL = '─';
export const PANEL_VERTICAL = '│';

// Tee corners used when a frame continues a box drawn directly above it (the
// editor's side borders under the status strip): `├────┤`.
export const PANEL_TEE_LEFT = '├';
export const PANEL_TEE_RIGHT = '┤';

/**
 * Padding around a frame title: the top border reads `╭ <title> ─…─╮`, so the
 * title carries one space on each side before the trailing dashes. Callers may
 * pass a padded title; the frame normalises it.
 */
export const PANEL_TITLE_PADDING = ' ';

/** Inner padding on each side of a body row: `│ <content> │`. */
export const PANEL_SIDE_PADDING = 1;

/**
 * Default left indent (cells). Transcript panels align their left edge with
 * message body text ({@link MESSAGE_INDENT}); status-strip panels override this
 * with `0`.
 */
export const PANEL_INDENT = 2;
