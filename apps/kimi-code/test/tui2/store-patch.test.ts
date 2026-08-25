/**
 * Tests for `Tui2Store.patch` — the spread-aware partial-write helper.
 *
 * SolidJS `createStore` setters replace at the given path, so a bare
 * `setState(key, { foo: x })` wipes every other field on that slice. The
 * `patch` helper spreads the current slice and merges the partial on top
 * — these tests pin that invariant for the slices that matter (and the
 * slices that don't, where patch should be a no-op).
 */

import { describe, expect, it } from 'vitest'

import { createTui2Store } from '@/tui2/state'

describe('Tui2Store.patch', () => {
  it('preserves sibling fields when patching an object slice', () => {
    const store = createTui2Store()
    store.setState('livePane', {
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
      activityPaneVisible: true,
    })

    store.patch('livePane', { mode: 'idle' })

    expect(store.state.livePane.mode).toBe('idle')
    expect(store.state.livePane.pendingApproval).toBeNull()
    expect(store.state.livePane.pendingQuestion).toBeNull()
    expect(store.state.livePane.activityPaneVisible).toBe(true)
  })

  it('overrides only the patched field for object slices', () => {
    const store = createTui2Store()
    store.patch('tasksBrowser', {
      tasks: [],
      filter: 'all',
      selectedTaskId: 'a',
      tailOutput: 'previous tail',
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: 'previous banner',
      viewer: undefined,
    })

    store.patch('tasksBrowser', { filter: 'active' })

    expect(store.state.tasksBrowser?.filter).toBe('active')
    expect(store.state.tasksBrowser?.selectedTaskId).toBe('a')
    expect(store.state.tasksBrowser?.tailOutput).toBe('previous tail')
    expect(store.state.tasksBrowser?.flashMessage).toBe('previous banner')
  })

  it('bootstraps an undefined slice with the partial shape', () => {
    const store = createTui2Store()
    expect(store.state.tasksBrowser).toBeUndefined()
    store.patch('tasksBrowser', {
      tasks: [],
      filter: 'all',
      selectedTaskId: undefined,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      viewer: undefined,
    })
    expect(store.state.tasksBrowser).toEqual({
      tasks: [],
      filter: 'all',
      selectedTaskId: undefined,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      viewer: undefined,
    })
  })

  it('is a no-op on a null slice', () => {
    const store = createTui2Store()
    store.setState('progressSpinner', null)
    expect(store.state.progressSpinner).toBeNull()
    store.patch('progressSpinner', { label: 'x' } as never)
    // null stays null — callers wanting to overwrite should use setState
    // directly (patch can't safely partial-merge into null).
    expect(store.state.progressSpinner).toBeNull()
  })

  it('is a no-op on a primitive slice (string)', () => {
    const store = createTui2Store()
    store.setState('editorDraft', 'hello')
    store.patch('editorDraft', 'world' as never)
    // A string slice can't be spread-merged meaningfully; the helper skips
    // and keeps the existing value. Callers that want to overwrite a
    // primitive should use setState directly.
    expect(store.state.editorDraft).toBe('hello')
  })

  it('preserves sibling keys when patching a dictionary slice', () => {
    const store = createTui2Store()
    store.patch('shellOutputs', {
      cmd1: { content: 'hello', finished: false },
    })
    store.patch('shellOutputs', {
      cmd2: { content: 'world', finished: false },
    })
    store.patch('shellOutputs', {
      cmd1: { content: 'hello world', finished: false },
    })

    expect(store.state.shellOutputs).toEqual({
      cmd1: { content: 'hello world', finished: false },
      cmd2: { content: 'world', finished: false },
    })
  })
})
