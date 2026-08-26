/**
 * Theme class + global singleton (opentui edition).
 *
 * Mirrors the shape of `tui/theme/theme.ts` but targets opentui's colour
 * model: opentui renderables take `ColorInput` (`string` hex, or `RGBA`)
 * via their `fg` / `bg` / `borderColor` props, NOT ANSI-wrapped strings.
 * So the v2 `Theme` resolves a `ColorToken` to a hex `ColorInput` instead of
 * wrapping text in chalk SGR codes. Component call sites read the current
 * palette through the singleton, so switching themes stays instantaneous.
 *
 * Text styling (bold / dim / italic / underline / strikethrough) is expressed
 * as opentui's numeric attribute bits (`TextAttributes`), provided here as
 * `attributes(token, textStyle)` helpers so renderers can apply them without
 * importing opentui directly.
 *
 * Status: REAL (tui2). Replaces the v1 chalk-backed stub.
 */

import { createSignal } from 'solid-js';
import { RGBA, TextAttributes } from '@opentui/core';
import type { ColorInput } from '@opentui/core';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';

export type ColorToken = keyof ColorPalette;

/** Opentui text-attribute bits that map to the v1 style vocabulary. */
export type TextStyle = 'bold' | 'dim' | 'italic' | 'underline' | 'strikethrough';

const STYLE_TO_ATTRIBUTE: Readonly<Record<TextStyle, number>> = {
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

export class Theme {
  /**
   * Palette behind a SolidJS signal: component call sites read
   * `currentTheme.color(...)` inside their render functions, so the read
   * subscribes them to the palette. `setPalette` (theme switch / auto
   * terminal-theme tracking) then re-renders every themed component in one
   * pass — without the signal, switching themes updated the singleton but
   * nothing repainted.
   */
  private readonly paletteSignal: [() => ColorPalette, (next: ColorPalette) => void];

  constructor(palette: ColorPalette) {
    this.paletteSignal = createSignal<ColorPalette>(palette);
  }

  get palette(): ColorPalette {
    return this.paletteSignal[0]();
  }

  setPalette(palette: ColorPalette): void {
    this.paletteSignal[1](palette);
  }

  /** Hex `ColorInput` for a semantic token — safe to pass to opentui props. */
  color(token: ColorToken): ColorInput {
    return this.paletteSignal[0]()[token];
  }

  /** Hex string (not RGBA) for token — convenient when building lookup tables. */
  hex(token: ColorToken): string {
    return this.paletteSignal[0]()[token];
  }

  /** RGBA instance for a token — for direct opentui manipulation. */
  rgba(token: ColorToken): RGBA {
    return RGBA.fromHex(this.paletteSignal[0]()[token]);
  }

  /** opentui attribute bits for a v1-style text style (or a combination). */
  attributes(style: TextStyle | readonly TextStyle[]): number {
    const styles: readonly TextStyle[] = Array.isArray(style) ? style : [style];
    return styles.reduce(
      (acc, s) => acc | (s in STYLE_TO_ATTRIBUTE ? STYLE_TO_ATTRIBUTE[s] : 0),
      TextAttributes.NONE,
    );
  }
}

/** Global singleton.  Initialise with dark palette; switch via `setPalette`. */
export const currentTheme = new Theme(darkColors);
