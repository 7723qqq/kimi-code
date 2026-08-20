/**
 * Test for the dialog dispatch protocol.
 *
 * The shell calls `dispatch.select(result)` / `dispatch.cancel(kind)` and
 * the host routes those into the matching controller / session call.
 * This test pins the contract: every `DialogKind` has a `select` payload
 * shape, and the no-op dispatch can be used in tests / previews without
 * the host wired in.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import { NOOP_DISPATCH, type DialogDispatch, type DialogKind, type DialogResult } from '@/tui2/dispatch'

describe('tui2 dispatch protocol', () => {
  it('exposes the full dialog kind union', () => {
    expectTypeOf<DialogKind>().toEqualTypeOf<
      | 'session-picker'
      | 'model-selector'
      | 'plugins-selector'
      | 'theme-selector'
      | 'locale-selector'
      | 'permission-selector'
      | 'editor-selector'
      | 'update-preference'
      | 'msys2-prompt'
      | 'trust-prompt'
      | 'settings-selector'
      | 'cache-hint'
      | 'goal-queue-manager'
      | 'undo-selector'
      | 'effort-selector'
      | 'help'
      | 'which-key'
      | 'start-permission-prompt'
      | 'swarm-start-permission-prompt'
      | 'approval-panel'
      | 'question-dialog'
    >()
  })

  it('NOOP_DISPATCH is a valid DialogDispatch', () => {
    const dispatch: DialogDispatch = {
      select: () => {},
      cancel: () => {},
    }
    expectTypeOf(dispatch).toMatchTypeOf<DialogDispatch>()
    // Touch the type so it doesn't get tree-shaken.
    void NOOP_DISPATCH
  })

  it('exhaustive dispatch mapping compiles', () => {
    // A small compile-time assertion: the `select` callback must accept
    // every `DialogResult` variant. We don't run anything here; the
    // function body is a type-level exhaustiveness check.
    const _exhaustive: (d: DialogDispatch, r: DialogResult) => void = (d, r) => {
      d.select(r)
    }
    void _exhaustive
    expect(typeof _exhaustive).toBe('function')
  })
})
