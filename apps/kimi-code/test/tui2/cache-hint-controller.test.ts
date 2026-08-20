/**
 * Tests for `createCacheHintController` — the "cache expired" interruption
 * logic. We cover the two pieces that are pure logic and host/network-free:
 * (1) the synchronous interception guard matrix that decides whether a
 * submit is swallowed at all, and (2) the prompt-cache-break detector in
 * `noteStepUsage`. The async hint/fetch path (which talks to the config
 * endpoint and mounts a dialog) is exercised by the real terminal boot
 * smoke test, not here.
 */

import { describe, expect, it, vi } from 'vitest'

import type { KimiHarness, ModelAlias, ProviderConfig, Session } from '@moonshot-ai/kimi-code-sdk'

import {
  createCacheHintController,
  type CacheHintController,
  type CacheHintHost,
} from '@/tui2/controllers/cache-hint-controller'
import { createTui2Store, type Tui2Store } from '@/tui2/state'

function createHarness(overrides?: Partial<CacheHintHost>): {
  store: Tui2Store
  host: CacheHintHost
  controller: CacheHintController
} {
  const store = createTui2Store()
  const host: CacheHintHost = {
    engineV2: true,
    harness: {
      auth: {
        // The fetch path is not exercised in these tests; make it fail loudly
        // so a guard regression that reaches the network becomes an error.
        getCachedAccessToken: () => {
          throw new Error('unexpected auth fetch in guard test')
        },
      },
    } as unknown as KimiHarness,
    session: {} as Session,
    store,
    track: vi.fn(),
    setAppState: (patch) => store.setState(patch as never),
    showError: vi.fn(),
    createNewSession: vi.fn(async () => {}),
    sendNormalUserInput: vi.fn(async () => {}),
    restoreInputText: vi.fn(),
    ...overrides,
  }
  return { store, host, controller: createCacheHintController(host) }
}

/** Configure a model whose provider is OAuth-managed so `upstreamModelId()`
 *  is defined (server-side cache rules then apply). */
function configureModel(store: Tui2Store): void {
  store.setState('model', 'kimi-k2')
  store.setState('availableModels', {
    'kimi-k2': { provider: 'moonshot', model: 'kimi-k2', maxContextSize: 200_000 } as ModelAlias,
  })
  store.setState('availableProviders', {
    moonshot: { oauth: { clientId: 'x' } } as unknown as ProviderConfig,
  })
}

describe('createCacheHintController interception guards', () => {
  it('never intercepts when the v2 engine is off', () => {
    const { controller } = createHarness({ engineV2: false })
    expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
  })

  it('never intercepts without a session', () => {
    const { controller } = createHarness({ session: undefined })
    expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
  })

  it('never intercepts with no recorded activity yet', () => {
    const { controller } = createHarness()
    expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
  })

  it('never intercepts an apiKey/self-hosted provider (no oauth)', () => {
    const { store, controller } = createHarness()
    // Model present but its provider is not OAuth-managed -> no hint rules.
    store.setState('model', 'local-model')
    controller.recordActivity()
    expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
  })

  it('skips interception when the hint preference is disabled', () => {
    vi.useFakeTimers()
    try {
      const { store, controller } = createHarness()
      configureModel(store)
      store.setState('cacheExpiryHint', false)
      controller.recordActivity()
      vi.advanceTimersByTime(61_000) // past the 60s freshness floor
      expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never intercepts while a turn is streaming', () => {
    vi.useFakeTimers()
    try {
      const { store, controller } = createHarness()
      configureModel(store)
      store.setState('streamingPhase', 'thinking')
      controller.recordActivity()
      vi.advanceTimersByTime(61_000)
      expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never intercepts while compacting', () => {
    vi.useFakeTimers()
    try {
      const { store, controller } = createHarness()
      configureModel(store)
      store.setState('isCompacting', true)
      controller.recordActivity()
      vi.advanceTimersByTime(61_000)
      expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never intercepts a submit inside the 60s freshness window', () => {
    const { store, controller } = createHarness()
    configureModel(store)
    controller.recordActivity()
    // No time advance: far under the 60s freshness floor.
    expect(controller.maybeInterceptOnSubmit('hi')).toBe(false)
  })
})

describe('createCacheHintController prompt-cache-break detection', () => {
  const highUsage = { inputOther: 100, output: 100, inputCacheRead: 100_000, inputCacheCreation: 0 }

  it('tracks a detected cache break when cache read drops sharply', () => {
    const { host, controller } = createHarness()
    controller.noteStepUsage(highUsage) // establishes the baseline
    controller.noteStepUsage({
      inputOther: 1000,
      output: 500,
      inputCacheRead: 1000,
      inputCacheCreation: 0,
    })
    expect(host.track).toHaveBeenCalledWith(
      'cache_break_detected',
      expect.objectContaining({ prev_input_cache_read: 100_000, curr_input_cache_read: 1000 }),
    )
  })

  it('does not track when cache read is stable between steps', () => {
    const { host, controller } = createHarness()
    controller.noteStepUsage(highUsage)
    controller.noteStepUsage({ ...highUsage })
    expect(host.track).not.toHaveBeenCalledWith('cache_break_detected', expect.anything())
  })

  it('ignores an all-zero usage (no meaningful step was measured)', () => {
    const { host, controller } = createHarness()
    controller.noteStepUsage(highUsage)
    controller.noteStepUsage({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 })
    expect(host.track).not.toHaveBeenCalled()
  })
})