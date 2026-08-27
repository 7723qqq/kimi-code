/**
 * TUI2 visible-width / truncation helpers.
 *
 * Mirrors the *behavior* of `packages/pi-tui/src/utils.ts` (visibleWidth /
 * truncateToWidth) so terminal layout stays consistent, but is fully
 * self-contained: ANSI/OSC stripping and grapheme width are computed inline,
 * with the east-asian width lookup replaced by a local wide-codepoint test.
 * This lets the tui2 build drop pi-tui without pulling in an extra runtime
 * dependency just for text measuring.
 *
 * Status: REAL (tui2). Self-contained; behavior mirrors the pi-tui algorithm.
 */

// Shared grapheme segmenter instance (matches pi-tui's shared instance usage).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const zeroWidthRegex = /[\p{Default_Ignorable_Code_Point}\p{Control}\p{Surrogate}]/v;
const combiningMarkRegex = /^\p{Mark}$/u;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;
const wideRegex =
  /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Script_Extensions=Han}\p{Script_Extensions=Hangul}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Bopomofo}]/v;

/**
 * Extract an ANSI escape sequence at `pos`. Returns its full code and the
 * number of source chars it covers, or null when `str[pos]` is not ESC.
 */
function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== '\u001B') return null;

  const next = str[pos + 1];

  // CSI sequence: ESC [ ... m/G/K/H/J
  if (next === '[') {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
    if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }

  // OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
  if (next === ']') {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === '\u0007') return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === '\u001B' && str[j + 1] === '\\') {
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }

  // APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
  if (next === '_') {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === '\u0007') return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === '\u001B' && str[j + 1] === '\\') {
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }

  return null;
}

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
  if (!str.includes('\u001B')) return str;
  let result = '';
  let i = 0;
  while (i < str.length) {
    const ansi = extractAnsiCode(str, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += str[i];
    i++;
  }
  return result;
}

/** Estimated terminal cells for a single grapheme cluster (approx. of pi-tui). */
function graphemeWidth(segment: string): number {
  if (segment === '\t') return 3;
  // Zero-width / combining controls take no cells; combining marks rarely do.
  if (zeroWidthRegex.test(segment) || combiningMarkRegex.test(segment)) return 0;
  // Emoji (incl. RGI sequences) and wide CJK scripts take two cells.
  if (rgiEmojiRegex.test(segment) || wideRegex.test(segment)) return 2;
  return 1;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
  if (str.length === 0) return 0;

  let clean = str;
  if (str.includes('\t')) {
    clean = clean.replaceAll(/\t/g, '   ');
  }
  if (clean.includes('\u001B')) {
    let stripped = '';
    let i = 0;
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += clean[i];
      i++;
    }
    clean = stripped;
  }

  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/**
 * Truncate text to fit within `maxWidth` visible columns, appending
 * `ellipsis` when content is cut and optionally padding to exactly `maxWidth`.
 * ANSI escapes do not count toward the width; a trailing reset is emitted so
 * styling does not leak past the truncated boundary.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = '…',
  pad: boolean = false,
): string {
  if (maxWidth <= 0) return '';
  if (text.length === 0) return pad ? ' '.repeat(maxWidth) : '';

  const textWidth = visibleWidth(text);
  const ellipsisWidth = visibleWidth(ellipsis);

  if (textWidth <= maxWidth) {
    return pad ? text + ' '.repeat(maxWidth - textWidth) : text;
  }

  const targetWidth = maxWidth - ellipsisWidth;
  if (targetWidth <= 0) {
    // Not enough room for the ellipsis next to a visible char; still try to
    // show the ellipsis alone if it fits within maxWidth.
    if (ellipsisWidth <= maxWidth) {
      return ellipsis + (pad ? ' '.repeat(maxWidth - ellipsisWidth) : '');
    }
    return '';
  }

  // Walk graphemes, skipping ANSI codes, and stop once the target width is hit.
  let result = '';
  let pendingAnsi = '';
  let keptWidth = 0;
  let i = 0;
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    let end = i;
    while (end < text.length && !extractAnsiCode(text, end)) end++;

    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const w = graphemeWidth(segment);
      if (keptWidth + w > targetWidth) {
        i = text.length;
        break;
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = '';
      }
      result += segment;
      keptWidth += w;
    }
    if (i >= text.length) break;
    i = end;
  }

  if (keptWidth === 0) {
    return ellipsis + (pad ? ' '.repeat(maxWidth - ellipsisWidth) : '');
  }

  const reset = '\u001B[0m';
  let out = `${result}${reset}${ellipsis}`;
  if (pad) out += ' '.repeat(Math.max(0, maxWidth - keptWidth - ellipsisWidth));
  return out;
}

// ── Preview width resolution & visual-row folding ───────────────────────

/**
 * Conservative column budget when neither a caller-provided width nor the
 * live terminal width is available (same 80-column fallback the banner and
 * the kimi-tui controller use).
 */
export const DEFAULT_PREVIEW_WIDTH = 80;

/**
 * Column budget for preview truncation: an explicit caller value wins,
 * then the live terminal width (the banner's `process.stdout.columns`
 * source), then the conservative default. Callers that know their actual
 * layout column (e.g. a transcript pane narrower than the terminal)
 * should pass it explicitly.
 */
export function resolvePreviewWidth(explicit: number | undefined): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const columns = process.stdout.columns;
  if (typeof columns === 'number' && Number.isFinite(columns) && columns >= 1) {
    return Math.floor(columns);
  }
  return DEFAULT_PREVIEW_WIDTH;
}

/** One measurable unit of a line: a grapheme (with any pending ANSI codes
 * glued on) or a trailing ANSI-only run. Zero-width by construction. */
interface WidthAtom {
  text: string;
  width: number;
  space: boolean;
}

function lineAtoms(line: string): WidthAtom[] {
  const atoms: WidthAtom[] = [];
  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      // Zero-width atom keeps the escape at its original position, so a
      // style open/close right before a wrapped-away gap still lands on
      // the correct side of the break.
      atoms.push({ text: ansi.code, width: 0, space: false });
      i += ansi.length;
      continue;
    }
    let end = i;
    while (end < line.length && !extractAnsiCode(line, end)) end++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, end))) {
      atoms.push({
        text: segment,
        width: graphemeWidth(segment),
        space: /\s/.test(segment),
      });
    }
    i = end;
  }
  return atoms;
}

/**
 * Fold one logical line into word-wrapped visual rows, each within
 * `maxWidth` visible columns — the same folding the layout applies with
 * `wrapMode="word"`, computed synchronously so previews can cap by what
 * the user actually sees instead of by logical line count. Words wider
 * than a full row hard-break; ANSI escapes ride along without consuming
 * width; leading indentation is preserved on the first row; an empty
 * line yields one empty row.
 */
export function wrapToVisualRows(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || visibleWidth(line) <= maxWidth) return [line];

  const rows: string[] = [];
  let row = '';
  let rowWidth = 0;
  let word: WidthAtom[] = [];
  let wordWidth = 0;
  let gap = '';
  let gapWidth = 0;

  // Place the pending word on the current row, flushing the row first when
  // the word (plus its separating gap) would overflow. A wrapped row drops
  // the gap; the line's original leading indentation is kept.
  const commitWord = (): void => {
    if (word.length === 0) return;
    if (rowWidth > 0 && rowWidth + gapWidth + wordWidth > maxWidth) {
      rows.push(row);
      row = '';
      rowWidth = 0;
    }
    if (rowWidth > 0 || rows.length === 0) {
      row += gap;
      rowWidth += gapWidth;
    }
    gap = '';
    gapWidth = 0;
    if (wordWidth <= maxWidth) {
      for (const atom of word) row += atom.text;
      rowWidth += wordWidth;
    } else {
      for (const atom of word) {
        if (rowWidth > 0 && atom.width > 0 && rowWidth + atom.width > maxWidth) {
          rows.push(row);
          row = '';
          rowWidth = 0;
        }
        row += atom.text;
        rowWidth += atom.width;
      }
    }
    word = [];
    wordWidth = 0;
  };

  for (const atom of lineAtoms(line)) {
    if (atom.space) {
      commitWord();
      gap += atom.text;
      gapWidth += atom.width;
    } else {
      word.push(atom);
      wordWidth += atom.width;
    }
  }
  commitWord();
  rows.push(row);
  return rows;
}