/**
 * TUI2 theme reactivity tests.
 *
 * `currentTheme` is a SolidJS-signal-backed singleton: component render
 * functions read `color()` / `hex()` / `rgba()` inside their body, which
 * subscribes them to the palette. `setPalette` (theme switch, auto
 * terminal-theme tracking) must re-run those reads — without the signal,
 * switching themes updated the singleton but nothing repainted.
 *
 * Note on the test environment: vitest resolves `solid-js` through the
 * `node` export condition (SSR build), where signals are plain closures
 * without subscription. These tests therefore pin the *value contract*
 * (reads return the current palette after a switch), which holds in every
 * build; the subscription behaviour itself is exercised by the real Bun
 * runtime, which resolves the browser build.
 */

import { describe, expect, it } from 'vitest'

import { darkColors, lightColors } from '@/tui2/theme/colors'
import { Theme, currentTheme } from '@/tui2/theme/theme'

describe('Theme', () => {
  it('reads return the current palette and follow setPalette', () => {
    const theme = new Theme(darkColors)
    expect(theme.color('text')).toBe(darkColors.text)
    expect(theme.hex('text')).toBe(darkColors.text)
    expect(theme.palette).toBe(darkColors)

    theme.setPalette(lightColors)
    expect(theme.color('text')).toBe(lightColors.text)
    expect(theme.hex('text')).toBe(lightColors.text)
    expect(theme.palette).toBe(lightColors)
  })

  it('the global singleton switches and restores the dark default', () => {
    const before = currentTheme.hex('text')
    currentTheme.setPalette(lightColors)
    expect(currentTheme.hex('text')).toBe(lightColors.text)
    expect(currentTheme.hex('text')).not.toBe(before)
    // Restore the dark default so other tests see a stable palette.
    currentTheme.setPalette(darkColors)
    expect(currentTheme.hex('text')).toBe(darkColors.text)
  })
})
