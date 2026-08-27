/**
 * TUI2 width-aware visual-row folding tests.
 *
 * Pins `wrapToVisualRows` (the primitive the truncated-output and thinking
 * previews use to cap by what the user actually sees instead of by logical
 * line count) across ASCII / CJK / emoji / ANSI content, plus
 * `resolvePreviewWidth` precedence and the source-level wiring of both
 * preview components to these helpers (mounting tui2 components under
 * vitest is currently impossible — see tool-renderers.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREVIEW_WIDTH,
  resolvePreviewWidth,
  wrapToVisualRows,
} from '@/tui2/utils/width';

const THINKING_SOURCE = join(__dirname, '..', '..', 'src', 'tui2', 'components', 'messages', 'thinking.tsx');
const TRUNCATED_SOURCE = join(
  __dirname,
  '..',
  '..',
  'src',
  'tui2',
  'components',
  'messages',
  'tool-renderers',
  'truncated.tsx',
);

// ── wrapToVisualRows ────────────────────────────────────────────────────

describe('wrapToVisualRows', () => {
  it('keeps lines that already fit on one visual row untouched', () => {
    expect(wrapToVisualRows('', 80)).toEqual(['']);
    expect(wrapToVisualRows('short line', 80)).toEqual(['short line']);
    expect(wrapToVisualRows('中文👍', 80)).toEqual(['中文👍']);
  });

  it('never folds when maxWidth is non-positive', () => {
    expect(wrapToVisualRows('a b c', 0)).toEqual(['a b c']);
  });

  it('word-wraps ASCII at spaces', () => {
    expect(wrapToVisualRows('aaa bbb ccc ddd', 10)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('folds CJK text every two columns per cell-wide char', () => {
    expect(wrapToVisualRows('中文中文中文', 4)).toEqual(['中文', '中文', '中文']);
  });

  it('hard-breaks a mixed-width word without spaces at the column budget', () => {
    // ab(2) 中(2) 文(2) fills exactly 6 columns; cd spills to the next row.
    expect(wrapToVisualRows('ab中文cd', 6)).toEqual(['ab中文', 'cd']);
  });

  it('counts emoji as two cells', () => {
    expect(wrapToVisualRows('👍👍👍', 4)).toEqual(['👍👍', '👍']);
  });

  it('keeps a ZWJ family emoji on one row as a single two-cell grapheme', () => {
    expect(wrapToVisualRows('x👨‍👩‍👦y', 5)).toEqual(['x👨‍👩‍👦y']);
  });

  it('treats combining marks as zero-width when breaking words', () => {
    expect(wrapToVisualRows('e\u0301x', 1)).toEqual(['e\u0301', 'x']);
  });

  it('carries ANSI escapes along without counting their width', () => {
    const rows = wrapToVisualRows('\x1B[31maaa bbb\x1B[0m ccc', 7);
    expect(rows).toEqual(['\x1B[31maaa bbb\x1B[0m', 'ccc']);
  });

  it('preserves leading indentation on the first row', () => {
    expect(wrapToVisualRows('    hello world', 8)).toEqual(['    hello', 'world']);
  });
});

// ── resolvePreviewWidth ─────────────────────────────────────────────────

describe('resolvePreviewWidth', () => {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');

  const setColumns = (value: number | undefined): void => {
    Object.defineProperty(process.stdout, 'columns', { value, configurable: true });
  };

  const restore = (): void => {
    if (stdoutDescriptor === undefined) return;
    Object.defineProperty(process.stdout, 'columns', stdoutDescriptor);
  };

  it('prefers an explicit caller-provided width', () => {
    try {
      setColumns(120);
      expect(resolvePreviewWidth(50)).toBe(50);
      expect(resolvePreviewWidth(undefined)).toBe(120);
    } finally {
      restore();
    }
  });

  it('falls back to the live terminal width, then the conservative default', () => {
    try {
      setColumns(undefined);
      expect(resolvePreviewWidth(undefined)).toBe(DEFAULT_PREVIEW_WIDTH);
      setColumns(132);
      expect(resolvePreviewWidth(undefined)).toBe(132);
    } finally {
      restore();
    }
  });

  it('ignores non-finite or sub-column explicit widths', () => {
    try {
      setColumns(undefined);
      expect(resolvePreviewWidth(Number.NaN)).toBe(DEFAULT_PREVIEW_WIDTH);
      expect(resolvePreviewWidth(0)).toBe(DEFAULT_PREVIEW_WIDTH);
    } finally {
      restore();
    }
  });
});

// ── Preview component wiring (source guard) ─────────────────────────────

describe('visual-row truncation wiring', () => {
  it('thinking and truncated previews fold through the width helpers', () => {
    expect(readFileSync(THINKING_SOURCE, 'utf8')).toContain('wrapToVisualRows');
    expect(readFileSync(THINKING_SOURCE, 'utf8')).toContain('resolvePreviewWidth');
    expect(readFileSync(TRUNCATED_SOURCE, 'utf8')).toContain('wrapToVisualRows');
    expect(readFileSync(TRUNCATED_SOURCE, 'utf8')).toContain('resolvePreviewWidth');
  });
});
