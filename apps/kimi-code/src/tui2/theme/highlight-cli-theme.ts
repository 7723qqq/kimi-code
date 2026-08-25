/**
 * TUI2 cli-highlight theme for code previews.
 *
 * Mirrors `tui/theme/highlight-theme.ts`: cli-highlight's DEFAULT_THEME paints
 * `string`, `regexp` and `deletion` tokens red; reset exactly those tokens to
 * `plain` so highlighted code contains no red at all. Tokens not listed fall
 * back to DEFAULT_THEME.
 *
 * Distinct from `tui2/theme/highlight-theme.ts`, which is the opentui
 * `SyntaxTokenTheme` consumed by opentui's tree-sitter highlighting; this file
 * keeps the plain-ANSI cli-highlight path self-contained.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import { plain } from 'cli-highlight';
import type { Theme } from 'cli-highlight';

export const codeHighlightTheme: Theme = {
  string: plain,
  regexp: plain,
  deletion: plain,
};