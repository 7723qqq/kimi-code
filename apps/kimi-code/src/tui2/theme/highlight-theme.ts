/**
 * Opentui syntax-highlight theme.
 *
 * Replaces `tui/theme/highlight-theme.ts`, which produced a cli-highlight
 * `Theme`. opentui owns its own code highlighting via `SyntaxStyle`
 * (tree-sitter token scopes), so the v2 counterpart is a set of
 * `ThemeTokenStyle` scopes that map the shared palette into the token
 * vocabulary consumed by `SyntaxStyle.fromTheme()`.
 *
 * The returned token list is pure data — it does not construct a
 * `SyntaxStyle` (that needs a live render lib), so it can be imported and
 * combined freely. Callers build the `SyntaxStyle` at render time.
 *
 * Status: REAL (tui2). Replaces the v1 cli-highlight stub.
 */

import type { ThemeTokenStyle } from '@opentui/core';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';

export interface SyntaxTokenTheme {
  readonly tokens: ThemeTokenStyle[];
}

/**
 * Build opentui syntax tokens from a palette.
 *
 * Scope names follow the tree-sitter / textmate conventions opentui's
 * tree-sitter client recognises. `text` falls back to the palette `text`
 * colour; keywords / types / strings use accent-family hues, matching the
 * v1 `codeHighlightTheme` intent (keep code readable, no raw reds).
 */
export function createCodeTokens(palette: ColorPalette = darkColors): ThemeTokenStyle[] {
  return [
    { scope: ['keyword', 'keyword.control'], style: { foreground: palette.primary } },
    { scope: ['string', 'string.quoted'], style: { foreground: palette.success } },
    { scope: ['comment'], style: { foreground: palette.textMuted, italic: true } },
    { scope: ['function', 'function.call'], style: { foreground: palette.accent } },
    { scope: ['type', 'type.builtin'], style: { foreground: palette.warning } },
    { scope: ['constant', 'constant.numeric'], style: { foreground: palette.roleUser } },
    { scope: ['operator'], style: { foreground: palette.textDim } },
    { scope: ['punctuation', 'punctuation.delimiter'], style: { foreground: palette.textMuted } },
    { scope: ['variable', 'variable.other'], style: { foreground: palette.text } },
    { scope: ['variable.parameter'], style: { foreground: palette.textStrong } },
    { scope: ['markup.heading'], style: { foreground: palette.textStrong, bold: true } },
    { scope: ['markup.bold'], style: { bold: true } },
    { scope: ['markup.italic'], style: { italic: true } },
    { scope: ['markup.link'], style: { foreground: palette.primary } },
  ];
}

/**
 * Default opentui syntax tokens for the dark palette, so callers that don't
 * want to thread a palette through can import one ready-made token list.
 */
export const defaultSyntaxTokens: ThemeTokenStyle[] = createCodeTokens(darkColors);

/** opentui-equivalent of the v1 `codeHighlightTheme` export. */
export const codeHighlightTheme: SyntaxTokenTheme = {
  tokens: createCodeTokens(darkColors),
};
