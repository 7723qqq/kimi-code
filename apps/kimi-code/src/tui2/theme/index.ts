/**
 * Theme system public API (opentui edition).
 *
 * Mirrors `tui/theme/index.ts` in purpose: expose the palette data, the
 * `Theme` singleton, terminal detection, and custom-theme loading. The
 * surface is opentui-flavoured (hex `ColorInput` instead of chalk ANSI
 * strings, `ThemeTokenStyle[]` instead of cli-highlight themes).
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import { getBuiltInPalette } from './colors';
import type { ColorPalette, ResolvedTheme } from './colors';
import { loadCustomThemeMerged } from './custom-theme-loader';
import { detectTerminalTheme } from './detect';

export { currentTheme, Theme } from './theme';
export type { ColorToken, TextStyle } from './theme';
export { darkColors, lightColors, getBuiltInPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme } from './detect';
export { loadCustomTheme, loadCustomThemeMerged, listCustomThemes } from './custom-theme-loader';
export {
  createCodeTokens,
  defaultSyntaxTokens,
  codeHighlightTheme,
  type SyntaxTokenTheme,
} from './highlight-theme';
export { gradientTextChunks, gradientTextPlain } from './gradient-text';
export {
  markdownColors,
  markdownSyntaxTokens,
  type MarkdownThemeColors,
} from './pi-tui-theme';

/**
 * User-facing theme preference.
 * `'auto'` defers to terminal background detection at startup.
 * `'dark'` / `'light'` are explicit built-in overrides.
 * Any other string is treated as a custom theme name looked up in
 * `~/.kimi-code/themes/<name>.json`.
 */
export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | (string & {});

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function isThemeName(_value: string): _value is ThemeName {
  return true; // any string is a valid theme name (custom themes)
}

/**
 * Resolve a user preference to a concrete palette.
 *
 * - `'auto'` triggers terminal background detection.
 * - `'dark'` / `'light'` return the built-in palette.
 * - Any other string loads a custom theme from `~/.kimi-code/themes/`;
 *   missing / invalid files fall back to dark palette.
 */
export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return getBuiltInPalette('light');
  if (theme === 'dark') return getBuiltInPalette('dark');
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return getBuiltInPalette(detected);
  }
  // custom theme
  const custom = await loadCustomThemeMerged(theme);
  return custom ?? getBuiltInPalette('dark');
}

/**
 * Synchronous fallback used by paths that cannot wait on terminal probes.
 * `'auto'` collapses to `'dark'`; explicit choices pass through.
 * Custom themes are not supported here — falls back to dark.
 */
export function getColorPaletteSync(theme: ThemeName): ColorPalette {
  if (theme === 'light') return getBuiltInPalette('light');
  return getBuiltInPalette('dark');
}
