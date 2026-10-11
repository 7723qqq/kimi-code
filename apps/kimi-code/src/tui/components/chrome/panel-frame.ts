/**
 * The canonical panel frame — one box language for panels in the transcript
 * and the status strip.
 *
 *     ╭ Title ────╮
 *     │ content  │
 *     ╰──────────╯
 *
 * `renderPanelFrame` draws the frame for a caller that renders its own body
 * rows; `wrapWithSideBorders` overlays the same corners and side bars onto an
 * existing block of rows (the editor and the Updates panel, whose top border is
 * a tab strip rather than a title).
 *
 * Colours arrive as a `paint` callback so a caller can route them through its
 * own hook (the editor's `borderColor`, a component's palette); the default is
 * read from `currentTheme` at render time so theme switches take effect on the
 * next frame.
 */

import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import {
  PANEL_BOTTOM_LEFT,
  PANEL_BOTTOM_RIGHT,
  PANEL_HORIZONTAL,
  PANEL_INDENT,
  PANEL_SIDE_PADDING,
  PANEL_TEE_LEFT,
  PANEL_TEE_RIGHT,
  PANEL_TITLE_PADDING,
  PANEL_TOP_LEFT,
  PANEL_TOP_RIGHT,
  PANEL_VERTICAL,
} from '#/tui/constant/panel';
import { currentTheme } from '#/tui/theme';

export type PanelPaint = (text: string) => string;

export interface PanelFrameOptions {
  /** Title. Padding is normalised, so `' Usage '` and `'Usage'` render alike. */
  readonly title: string;
  /**
   * Body rows, painted and clipped by the frame. Callers keep their own inner
   * indent (e.g. section rows indented two cells) — the frame adds only the
   * `│ ` / ` │` inner padding.
   */
  readonly body: readonly string[];
  readonly width: number;
  /** Border paint. Defaults to the `border` / `borderFocus` palette token. */
  readonly paint?: PanelPaint;
  /**
   * Title paint. Defaults to `paint`. Callers whose title was already bold
   * (`primary` + bold) pass a bold painter; the usage family keeps the border
   * paint so its emitted strings do not change.
   */
  readonly titlePaint?: PanelPaint;
  /** Left indent in cells; defaults to {@link PANEL_INDENT}. */
  readonly indent?: number;
  /** Inner padding on each side of a body row; defaults to `PANEL_SIDE_PADDING`. */
  readonly sidePadding?: number;
  /** Selects the default border token when `paint` is omitted. */
  readonly focused?: boolean;
  /**
   * Span the available width instead of hugging the content. Status-strip
   * panels and full-width transcript cards (todo, approval, device code) use
   * this; command panels that sit next to message text stay content-sized.
   */
  readonly stretch?: boolean;
}

/**
 * Render the canonical frame around `body`.
 *
 * Width behaviour mirrors the usage panel this was extracted from:
 * - `width <= 0` collapses to one empty row;
 * - when the indent, borders and inner padding leave no interior, the box is
 *   dropped and the title/body are emitted as plain truncated rows;
 * - the box is otherwise sized to its content, capped at the available
 *   interior, and every row is finally truncated to `width`.
 */
export function renderPanelFrame(options: PanelFrameOptions): string[] {
  const { title: rawTitle, body, width } = options;
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) return [''];

  const paint: PanelPaint =
    options.paint ??
    ((text: string) => currentTheme.fg(options.focused === true ? 'borderFocus' : 'border', text));
  const titlePaint = options.titlePaint ?? paint;

  const indentWidth = Math.max(0, options.indent ?? PANEL_INDENT);
  const sidePadding = Math.max(0, options.sidePadding ?? PANEL_SIDE_PADDING);
  const indent = ' '.repeat(indentWidth);
  // Two border columns + the inner padding on each side.
  const availableInterior = safeWidth - (indentWidth + 2 + 2 * sidePadding);

  // The title is stored with its own padding at the call sites (i18n keys such
  // as `' Usage '`), so normalise it first and let the frame own the canonical
  // `╭ <title> ─…╮` spacing. A whitespace-only title is left untouched.
  const label = rawTitle.trim();
  const title = label.length > 0 ? PANEL_TITLE_PADDING + label + PANEL_TITLE_PADDING : rawTitle;

  if (availableInterior < 1) {
    return [
      truncateToWidth(title.trim(), safeWidth, '…'),
      ...body.map((line) => truncateToWidth(line, safeWidth, '…')),
    ];
  }

  const longestLine = body.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const contentWidth =
    options.stretch === true
      ? Math.max(1, availableInterior)
      : Math.max(
          1,
          Math.min(availableInterior, Math.max(longestLine, visibleWidth(title))),
        );
  const horzLen = contentWidth + 2 * sidePadding;
  const clippedTitle = truncateToWidth(title, horzLen, '…');
  const trailingDashLen = Math.max(0, horzLen - visibleWidth(clippedTitle));

  const out: string[] = [
    indent +
      paint(PANEL_TOP_LEFT) +
      titlePaint(clippedTitle) +
      paint(PANEL_HORIZONTAL.repeat(trailingDashLen)) +
      paint(PANEL_TOP_RIGHT),
  ];
  const padding = ' '.repeat(sidePadding);
  for (const line of body) {
    const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
    const pad = Math.max(0, contentWidth - visibleWidth(clipped));
    out.push(
      indent +
        paint(PANEL_VERTICAL) +
        padding +
        clipped +
        ' '.repeat(pad) +
        padding +
        paint(PANEL_VERTICAL),
    );
  }
  out.push(
    indent + paint(PANEL_BOTTOM_LEFT + PANEL_HORIZONTAL.repeat(horzLen) + PANEL_BOTTOM_RIGHT),
  );
  return out.map((line) => truncateToWidth(line, safeWidth, '…'));
}

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** Visible text of a row, with SGR sequences removed (mirrors the editor's). */
function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, '');
}

/**
 * Post-process pi-tui's editor output to draw a full box around it.
 *
 * pi-tui only renders horizontal top/bottom borders; we wrap them with
 * `╭╮╰╯` corners and add vertical `│` bars on each row's outer columns.
 * Horizontal-border rows (those whose first visible char is `─`, including
 * scroll indicators like `── ↑ N more ──`) are stripped of their existing
 * SGR and repainted as a single box-drawn span. Content rows keep their
 * inner SGR intact; only column 0 and the last column are overlaid, and
 * only if they're literal spaces — that protects the cursor-overflow
 * case where the rightmost column is an SGR-tagged inverse cursor.
 *
 * When `options.label` is set, it is overlaid on the left of the top border
 * (e.g. the `! shell mode` badge), replacing the leading dashes. It is only
 * applied to a plain dash run, never to a `↑/↓ N more` scroll indicator.
 */
export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
  options: { readonly connectedAbove?: boolean; readonly label?: string } = {},
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === PANEL_HORIZONTAL) {
      const isTop = !seenTop;
      const leftCorner = seenTop
        ? PANEL_BOTTOM_LEFT
        : options.connectedAbove === true
          ? PANEL_TEE_LEFT
          : PANEL_TOP_LEFT;
      const rightCorner = seenTop
        ? PANEL_BOTTOM_RIGHT
        : options.connectedAbove === true
          ? PANEL_TEE_RIGHT
          : PANEL_TOP_RIGHT;
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      if (isTop && options.label !== undefined && /^─+$/.test(middle)) {
        const labelWidth = visibleWidth(options.label);
        if (labelWidth <= middle.length) {
          return (
            paint(leftCorner) +
            options.label +
            paint(PANEL_HORIZONTAL.repeat(middle.length - labelWidth)) +
            paint(rightCorner)
          );
        }
      }
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === ' ' ? paint(PANEL_VERTICAL) : (firstCh ?? '');
    const tail = line.length > 1 && lastCh === ' ' ? paint(PANEL_VERTICAL) : (lastCh ?? '');
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}
