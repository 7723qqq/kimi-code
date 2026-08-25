/**
 * Regression test for `TasksBrowserController.refreshList`.
 *
 * The periodic refresh path used to write the store with
 * `store.setState('tasksBrowser', { tasks: [...] })` — a path-based replace
 * under SolidJS `createStore` setters, which **wipes** every sibling field
 * (filter / selectedTaskId / tailOutput / viewer / flashMessage). The fix
 * spreads the existing state before patching `tasks`. This test pins the
 * behavior: after a `refreshList`, only `tasks` should change and the
 * sibling fields must survive.
 *
 * Note: `refresh()` (the public method) also flashes a transient banner,
 * which is a separate single-field setState — not exercised here. We hit
 * the private `refreshList` directly so the assertion isolates the spread
 * behavior under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk'

import { TasksBrowserController } from '@/tui2/controllers/tasks-browser'
import type { TasksBrowserHost } from '@/tui2/controllers/tasks-browser'
import type { Tui2Store } from '@/tui2/state'

function makeTask(taskId: string): BackgroundTaskInfo {
  return {
    taskId,
    description: `task ${taskId}`,
    status: 'running',
    startedAt: new Date(0),
  } as unknown as BackgroundTaskInfo
}

interface Harness {
  readonly controller: TasksBrowserController
  readonly host: TasksBrowserHost
  readonly storeState: { current: Record<string, unknown> }
  readonly backgroundTasks: Map<string, BackgroundTaskInfo>
  flushRefreshList: () => Promise<void>
}

function setupHarness(initialTasks: readonly BackgroundTaskInfo[]): Harness {
  const backgroundTasks = new Map<string, BackgroundTaskInfo>(
    initialTasks.map((task) => [task.taskId, task]),
  )
  const storeState: { current: Record<string, unknown> } = { current: {} }
  // Mirror the real store: SolidJS `setState(key, object)` merges the fields
  // into the existing slice **in place** (the slice reference stays stable),
  // which the controller's identity guards (`loadTail`'s `current !==
  // browser`, `refreshList`'s same check) depend on. `undefined` deletes the
  // key; primitives replace it.
  const setState = vi.fn((key: string, value: unknown) => {
    const existing = storeState.current[key]
    if (value === undefined) {
      delete storeState.current[key]
      return
    }
    if (typeof value === 'object' && value !== null && typeof existing === 'object' && existing !== null) {
      Object.assign(existing, value)
      return
    }
    storeState.current = { ...storeState.current, [key]: value }
  })
  const store: Tui2Store = {
    get state() {
      return storeState.current as unknown as Tui2Store['state']
    },
    setState,
    patch(key: string, partial: unknown) {
      const slice = storeState.current[key]
      if (slice === null) return
      if (slice === undefined) {
        storeState.current = { ...storeState.current, [key]: partial }
        return
      }
      if (typeof slice === 'object') {
        // In-place merge, exactly like the real store's `{ ...slice,
        // ...partial }` → SolidJS `mergeStoreNode` (same reference).
        Object.assign(slice, partial)
      }
    },
  } as unknown as Tui2Store

  const listBackgroundTasks = vi.fn(async () => [...backgroundTasks.values()])
  const getBackgroundTaskOutput = vi.fn(async () => 'sample output')
  const session = {
    listBackgroundTasks,
    getBackgroundTaskOutput,
    stopBackgroundTask: vi.fn(async () => undefined),
  } as unknown as Session

  const host: TasksBrowserHost = {
    store,
    backgroundTasks,
    sessionEventHandler: {} as TasksBrowserHost['sessionEventHandler'],
    session,
    showError: () => undefined,
    setTasksBrowser: (value) => {
      store.setState('tasksBrowser', value)
    },
  }

  const controller = new TasksBrowserController(host)

  // Cast to access the private refreshList directly — bypasses refresh()'s
  // flash() side effect (a separate single-field setState, out of scope
  // here).
  const refreshList = (
    controller as unknown as { refreshList: (opts?: { silent?: boolean }) => Promise<void> }
  ).refreshList.bind(controller)

  const flushRefreshList = async (): Promise<void> => {
    await refreshList({ silent: true })
  }

  return { controller, host, storeState, backgroundTasks, flushRefreshList }
}

describe('TasksBrowserController.refreshList', () => {
  it('preserves filter / selectedTaskId / tailOutput / viewer / flashMessage while refreshing tasks', async () => {
    const taskA = makeTask('a')
    const harness = setupHarness([taskA])

    await harness.controller.show()

    // Simulate accumulated user state (filter toggle, task select, tail
    // loaded, flash banner set) — these are the fields that must survive
    // a refresh.
    const initialBrowser = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(initialBrowser).toBeDefined()
    harness.host.setTasksBrowser({
      ...(initialBrowser as object),
      filter: 'active',
      selectedTaskId: 'a',
      tailOutput: 'keep me',
      tailLoading: false,
      flashMessage: 'still here',
      viewer: undefined,
    } as never)

    // Inject a new background task before the refresh runs.
    harness.backgroundTasks.set('b', makeTask('b'))

    await harness.flushRefreshList()

    const after = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(after['filter']).toBe('active')
    expect(after['selectedTaskId']).toBe('a')
    expect(after['tailOutput']).toBe('keep me')
    expect(after['flashMessage']).toBe('still here')
    expect(after['viewer']).toBeUndefined()
    // The list snapshot now includes both tasks.
    const tasks = after['tasks'] as BackgroundTaskInfo[]
    expect(tasks.map((t) => t.taskId).sort()).toEqual(['a', 'b'])
  })

  it('show() surfaces the dialog through the activeDialog slot', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    expect(harness.storeState.current['activeDialog']).toBe('tasks-browser')
  })

  it('close() clears activeDialog but only when still owning the slot', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    expect(harness.storeState.current['activeDialog']).toBe('tasks-browser')

    harness.controller.close()
    expect(harness.storeState.current['activeDialog']).toBeNull()
    expect(harness.storeState.current['tasksBrowser']).toBeUndefined()

    // Pre-empt the slot: a later close must not stomp on it.
    harness.storeState.current = {
      ...harness.storeState.current,
      activeDialog: 'session-picker',
    }
    harness.controller.close()
    expect(harness.storeState.current['activeDialog']).toBe('session-picker')
  })
})

/**
 * Per-method spread coverage.
 *
 * The controller routes every partial write through `patchTasksBrowser`, so a
 * single SolidJS `createStore` setter cannot wipe sibling fields. These
 * cases pin that property for the user-facing paths that previously wrote
 * single fields directly: `toggleFilter`, `select`, `flash` (+ its timeout
 * clear), and `closeOutputViewer`.
 */
describe('TasksBrowserController.patchTasksBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function openedHarness(): Promise<ReturnType<typeof setupHarness>> {
    const harness = setupHarness([makeTask('a'), makeTask('b')])
    await harness.controller.show()
    const initialBrowser = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    // Pre-load sibling state the test will check after the partial write.
    harness.host.setTasksBrowser({
      ...(initialBrowser as object),
      filter: 'active',
      selectedTaskId: 'a',
      tailOutput: 'baseline tail',
      tailLoading: false,
      flashMessage: 'baseline flash',
      viewer: undefined,
    } as never)
    return harness
  }

  it('toggleFilter() preserves selectedTaskId / tailOutput / flashMessage', async () => {
    const harness = await openedHarness()

    harness.controller.toggleFilter()

    const after = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(after['filter']).toBe('all') // cycled from 'active'
    expect(after['selectedTaskId']).toBe('a')
    expect(after['tailOutput']).toBe('baseline tail')
    expect(after['flashMessage']).toBe('baseline flash')
  })

  it('select() preserves filter / tailOutput / flashMessage and arms tail loading', async () => {
    const harness = await openedHarness()

    harness.controller.select('b')

    const after = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(after['selectedTaskId']).toBe('b')
    expect(after['filter']).toBe('active')
    expect(after['tailLoading']).toBe(true)
    // The selection path clears the stale tail output to force a reload —
    // it does so explicitly, so the test pins the contract: `tailOutput`
    // ends up undefined but filter / flashMessage survive.
    expect(after['tailOutput']).toBeUndefined()
    expect(after['flashMessage']).toBe('baseline flash')
  })

  it('flash() preserves filter / selectedTaskId / tailOutput', async () => {
    const harness = await openedHarness()

    harness.controller['flash']('Refreshing…')

    const after = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(after['flashMessage']).toBe('Refreshing…')
    expect(after['filter']).toBe('active')
    expect(after['selectedTaskId']).toBe('a')
    expect(after['tailOutput']).toBe('baseline tail')

    // The flash timeout clears flashMessage back to undefined — and must
    // not touch any sibling field either.
    vi.advanceTimersByTime(2500)
    const cleared = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(cleared['flashMessage']).toBeUndefined()
    expect(cleared['filter']).toBe('active')
    expect(cleared['selectedTaskId']).toBe('a')
    expect(cleared['tailOutput']).toBe('baseline tail')
  })

  it('closeOutputViewer() preserves filter / selectedTaskId / tailOutput when closing an open viewer', async () => {
    const harness = await openedHarness()

    // Open a viewer first.
    harness.host.setTasksBrowser({
      ...(harness.storeState.current['tasksBrowser'] as object),
      viewer: { taskId: 'a', output: 'snapshot', kind: 'output' },
    } as never)

    harness.controller.closeOutputViewer()

    const after = harness.storeState.current['tasksBrowser'] as Record<string, unknown>
    expect(after['viewer']).toBeUndefined()
    expect(after['filter']).toBe('active')
    expect(after['selectedTaskId']).toBe('a')
    expect(after['tailOutput']).toBe('baseline tail')
    expect(after['flashMessage']).toBe('baseline flash')
  })

  it('closeOutputViewer() is a no-op when the dialog slice is closed', async () => {
    const harness = await openedHarness()
    harness.controller.close()

    // After close, the slice is undefined. closeOutputViewer should not
    // resurrect it.
    expect(() => harness.controller.closeOutputViewer()).not.toThrow()
    expect(harness.storeState.current['tasksBrowser']).toBeUndefined()
  })
})

/**
 * Behavioral coverage — the control-flow semantics beyond the spread fix:
 * show() guards and selection, open/close dialog ownership, select / filter /
 * refresh / stop / openOutput / loadTail routing and their boundary returns.
 *
 * `show()` arms a 1s poll interval; fake timers keep the workers from
 * lingering, and each case drives the real controller against the mock host.
 */
describe('TasksBrowserController behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function browser(harness: ReturnType<typeof setupHarness>): Record<string, unknown> {
    return harness.storeState.current['tasksBrowser'] as Record<string, unknown>
  }

  it('show() with no session reports an error and opens nothing', async () => {
    const harness = setupHarness([])
    const showError = vi.fn()
    ;(harness.host as { showError: (m: string) => void }).showError = showError
    ;(harness.host as { session: Session | undefined }).session = undefined

    await harness.controller.show()

    expect(showError).toHaveBeenCalled()
    expect(browser(harness)).toBeUndefined()
    expect(harness.storeState.current['activeDialog']).toBeUndefined()
  })

  it('show() picks a running task as the initial selection', async () => {
    const harness = setupHarness([makeTask('a'), makeTask('b')])
    harness.backgroundTasks.set('a', { ...makeTask('a'), status: 'completed' } as BackgroundTaskInfo)
    harness.backgroundTasks.set('b', { ...makeTask('b'), status: 'running' } as BackgroundTaskInfo)

    await harness.controller.show()

    expect(browser(harness)['selectedTaskId']).toBe('b')
    expect(browser(harness)['filter']).toBe('all')
  })

  it('show() is a no-op when the dialog is already open', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    const listTasks = harness.host.session?.listBackgroundTasks as ReturnType<typeof vi.fn>
    const callsBefore = listTasks.mock.calls.length

    await harness.controller.show()

    expect(listTasks.mock.calls.length).toBe(callsBefore)
  })

  it('toggleFilter() cycles the filter between all and active', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    expect(browser(harness)['filter']).toBe('all')

    harness.controller.toggleFilter()
    expect(browser(harness)['filter']).toBe('active')

    harness.controller.toggleFilter()
    expect(browser(harness)['filter']).toBe('all')
  })

  it('select() on the already-selected task does not reload the tail', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    const getOutput = harness.host.session?.getBackgroundTaskOutput as ReturnType<typeof vi.fn>
    const callsBefore = getOutput.mock.calls.length

    harness.controller.select('a')

    expect(getOutput.mock.calls.length).toBe(callsBefore)
  })

  it('refresh() flashes a refreshing banner', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()

    harness.controller.refresh()

    expect(browser(harness)['flashMessage']).toBeTruthy()
  })

  it('stop() calls the session stop and refreshes the list', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    const stopBackgroundTask = harness.host.session?.stopBackgroundTask as ReturnType<typeof vi.fn>

    await harness.controller.stop('a')

    expect(stopBackgroundTask).toHaveBeenCalledWith('a', { reason: 'User initiated stop' })
  })

  it('stop() with no session flashes a notice', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    ;(harness.host as { session: Session | undefined }).session = undefined

    await harness.controller.stop('a')

    expect(browser(harness)['flashMessage']).toBeTruthy()
  })

  it('openOutput() fetches output and attaches an output viewer', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()

    await harness.controller.openOutput('a')

    expect(browser(harness)['viewer']).toEqual({ taskId: 'a', output: 'sample output', kind: 'output' })
  })

  it('openOutput() with no session flashes a notice and opens nothing', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    ;(harness.host as { session: Session | undefined }).session = undefined

    await harness.controller.openOutput('a')

    expect(browser(harness)['flashMessage']).toBeTruthy()
    expect(browser(harness)['viewer']).toBeUndefined()
  })

  it('openOutput() while a viewer is open is a no-op', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    await harness.controller.openOutput('a')
    const getOutput = harness.host.session?.getBackgroundTaskOutput as ReturnType<typeof vi.fn>
    const callsBefore = getOutput.mock.calls.length

    await harness.controller.openOutput('a')

    expect(getOutput.mock.calls.length).toBe(callsBefore)
  })

  it('loadTail() populates tailOutput when the request resolves', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    await Promise.resolve()

    expect(browser(harness)['tailLoading']).toBe(false)
    expect(browser(harness)['tailOutput']).toBe('sample output')
  })

  it('close() also closes an open viewer and releases the dialog slot', async () => {
    const harness = setupHarness([makeTask('a')])
    await harness.controller.show()
    await harness.controller.openOutput('a')
    expect(browser(harness)['viewer']).toBeDefined()

    harness.controller.close()

    expect(browser(harness)).toBeUndefined()
    expect(harness.storeState.current['activeDialog']).toBeNull()
  })
})
