/**
 * Tests for the tui2 goal-queue manager/edit dialogs — pure helpers.
 *
 * The dialogs render through opentui (`useKeyboard` + JSX), which is not
 * exercised in unit tests; the editable behavior they expose is pinned
 * here through the pure text-model helpers ported from the v1 dialog
 * (see `test/tui/components/dialogs/goal-queue-manager.test.ts` for the
 * original contract).
 */

import { describe, expect, it } from 'vitest'

import {
  cursorLocation,
  formatListObjective,
  lineStarts,
  nextGraphemeEnd,
  normalizeNewlines,
  previousGraphemeStart,
  sanitizePastedText,
  visibleLineRange,
} from '@/tui2/components/dialogs/goal-queue-manager'

describe('normalizeNewlines', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('leaves LF-only text unchanged', () => {
    expect(normalizeNewlines('a\nb\nc')).toBe('a\nb\nc')
  })
})

describe('formatListObjective', () => {
  it('collapses whitespace and trims', () => {
    expect(formatListObjective('  a\t b \n c  ')).toBe('a b c')
  })
})

describe('sanitizePastedText', () => {
  it('strips ANSI CSI sequences', () => {
    expect(sanitizePastedText('\u001B[31mred\u001B[0m text')).toBe('red text')
  })

  it('drops control characters but keeps newlines and printable text', () => {
    expect(sanitizePastedText('line1\u0000\u0007line2')).toBe('line1line2')
    expect(sanitizePastedText('a\nb')).toBe('a\nb')
  })

  it('keeps wide CJK characters', () => {
    expect(sanitizePastedText('目标 修复')).toBe('目标 修复')
  })
})

describe('lineStarts', () => {
  it('returns one entry per line', () => {
    expect(lineStarts('ab\ncd\ne')).toEqual([0, 3, 6])
    expect(lineStarts('')).toEqual([0])
  })
})

describe('cursorLocation', () => {
  it('computes line and column from an offset', () => {
    const text = 'ab\ncd\nef'
    expect(cursorLocation(text, 0)).toEqual({ line: 0, column: 0 })
    expect(cursorLocation(text, 4)).toEqual({ line: 1, column: 1 })
    expect(cursorLocation(text, 7)).toEqual({ line: 2, column: 1 })
  })
})

describe('previousGraphemeStart / nextGraphemeEnd', () => {
  it('moves by one grapheme (not code unit)', () => {
    const text = 'a😀b'
    expect(previousGraphemeStart(text, 3)).toBe(1)
    expect(nextGraphemeEnd(text, 1)).toBe(3)
  })

  it('clamps at the edges', () => {
    expect(previousGraphemeStart('ab', 0)).toBe(0)
    expect(nextGraphemeEnd('ab', 2)).toBe(2)
  })
})

describe('visibleLineRange', () => {
  it('shows everything when short', () => {
    expect(visibleLineRange(3, 1)).toEqual({ start: 0, end: 3 })
  })

  it('windows around the cursor line on long inputs', () => {
    expect(visibleLineRange(20, 0)).toEqual({ start: 0, end: 8 })
    expect(visibleLineRange(20, 19)).toEqual({ start: 12, end: 20 })
    expect(visibleLineRange(20, 10)).toEqual({ start: 6, end: 14 })
  })
})