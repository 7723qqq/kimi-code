/**
 * Opentui markdown theme adapters.
 *
 * Replaces `tui/theme/pi-tui-theme.ts`, which built pi-tui's
 * `MarkdownTheme` / `EditorTheme` (chalk-backed). opentui renders markdown
 * with its own `<markdown>` renderable driven by a `syntaxStyle`
 * (`ThemeTokenStyle[]`) plus `fg` / `bg` / `conceal` props, so there is no
 * per-token callback theme to construct. The v2 counterpart resolves the
 * shared palette into the opentui markdown inputs:
 *
 *   - `markdownColors(palette)` → fg / heading / link / quote / code colour
 *     map, consumed when building a `<markdown>` renderable's options.
 *   - `markdownSyntaxTokens(palette)` → `ThemeTokenStyle[]` for
 *     `SyntaxStyle.fromTheme()` (inline + fenced code).
 *
 * Colour lookups route through `currentTheme` (or an injected palette) so
 * switching themes is instantaneous — stale renderables read the *current*
 * palette via the singleton.
 *
 * Status: REAL (tui2). Replaces the v1 pi-tui MarkdownTheme stub.
 */

import type { ColorInput, ThemeTokenStyle } from '@opentui/core';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';
import { currentTheme } from './theme';
import type { ColorToken, Theme } from './theme';

export interface MarkdownThemeColors {
  /** Default body text colour. */
  readonly fg: ColorInput;
  /** Markdown headings. */
  readonly heading: ColorInput;
  /** Inline links. */
  readonly link: ColorInput;
  /** Link URLs / faint chrome. */
  readonly linkUrl: ColorInput;
  /** Inline code + fenced code text. */
  readonly code: ColorInput;
  /** Blockquote text. */
  readonly quote: ColorInput;
  /** Horizontal rules / borders. */
  readonly hr: ColorInput;
}

const TOKEN_FOR: Record<keyof MarkdownThemeColors, ColorToken> = {
  fg: 'text',
  heading: 'textStrong',
  link: 'primary',
  linkUrl: 'textMuted',
  code: 'primary',
  quote: 'textDim',
  hr: 'border',
};

/** Resolve the markdown colour map from a palette (via `currentTheme` by default). */
export function markdownColors(theme: Pick<Theme, 'color'> = currentTheme): MarkdownThemeColors {
  const entries = Object.entries(TOKEN_FOR) as [keyof MarkdownThemeColors, ColorToken][];
  const colors = {} as Record<keyof MarkdownThemeColors, ColorInput>;
  for (const [key, token] of entries) colors[key] = theme.color(token);
  return colors;
}

/**
 * Build opentui `ThemeTokenStyle[]` for markdown (inline + fenced code),
 * derived from the markdown colour map. Pass the result to
 * `SyntaxStyle.fromTheme()`.
 */
export function markdownSyntaxTokens(palette: ColorPalette = darkColors): ThemeTokenStyle[] {
  return [
    { scope: ['markup.heading'], style: { foreground: palette.textStrong, bold: true } },
    { scope: ['markup.link'], style: { foreground: palette.primary } },
    { scope: ['markup.bold'], style: { bold: true } },
    { scope: ['markup.italic'], style: { italic: true } },
    { scope: ['markup.quote'], style: { foreground: palette.textDim } },
    { scope: ['markup.raw', 'markup.inline.raw'], style: { foreground: palette.primary } },
    { scope: ['markup.code'], style: { foreground: palette.primary } },
  ];
}
