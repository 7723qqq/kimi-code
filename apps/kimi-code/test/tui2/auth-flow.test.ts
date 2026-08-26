/**
 * Tests for `AuthFlowController` — the login/logout session lifecycle.
 *
 * The controller is pure orchestration over the injected `AuthFlowHost`
 * (real `Tui2Store`, mocked harness/session/options/host callbacks). The
 * provider-model refresh orchestrator is mocked so the scope fan-out and the
 * two-phase atomic persistence host can be asserted directly; `getConfig` /
 * `createSession` on the harness are mocked as well.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreateSessionOptions, KimiConfig, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk'

import { AuthFlowController, type AuthFlowHost } from '@/tui2/controllers/auth-flow'
import type { SessionEventHandler } from '@/tui2/controllers/session-event-handler'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { KimiTUIOptions } from '@/tui2/types'

const refreshAllProviderModels = vi.fn()
vi.mock('@/tui2/utils/refresh-providers', () => ({ refreshAllProviderModels }))

interface Harness {
  readonly controller: AuthFlowController
  readonly store: Tui2Store
  readonly harness: KimiHarness
  readonly mocks: HarnessMocks
  readonly session: Session | undefined
  readonly createdSession: Session
  readonly options: KimiTUIOptions
  readonly setAppState: ReturnType<typeof vi.fn>
  readonly setStartupReady: ReturnType<typeof vi.fn>
  readonly resetSessionRuntime: ReturnType<typeof vi.fn>
  readonly setSession: ReturnType<typeof vi.fn>
  readonly syncRuntimeState: ReturnType<typeof vi.fn>
  readonly closeSession: ReturnType<typeof vi.fn>
  readonly appendStartupNotice: ReturnType<typeof vi.fn>
  readonly hydrateLazyConfigDefaults: ReturnType<typeof vi.fn>
  readonly fetchSessions: ReturnType<typeof vi.fn>
  readonly updateTerminalTitle: ReturnType<typeof vi.fn>
  readonly refreshSkillCommands: ReturnType<typeof vi.fn>
  readonly refreshPluginCommands: ReturnType<typeof vi.fn>
  readonly sessionEventHandler: SessionEventHandler
}

function makeConfig(overrides: Partial<KimiConfig> = {}): KimiConfig {
  return {
    models: { 'kimi-k2': { id: 'kimi-k2', maxContextSize: 131072 } },
    providers: { moonshot: { id: 'moonshot' } },
    ...overrides,
  } as unknown as KimiConfig
}

interface HarnessMocks {
  readonly getConfig: ReturnType<typeof vi.fn>
  readonly createSession: ReturnType<typeof vi.fn>
  readonly removeProvider: ReturnType<typeof vi.fn>
  readonly setConfig: ReturnType<typeof vi.fn>
  readonly replaceConfigSections: ReturnType<typeof vi.fn>
  readonly supportsAtomicSectionReplace: ReturnType<typeof vi.fn>
  readonly resolveOAuthTokenProvider: ReturnType<typeof vi.fn>
}

function makeHarness(
  config: KimiConfig = makeConfig(),
  createSessionResult: Session = makeSession(),
): { harness: KimiHarness; mocks: HarnessMocks } {
  const getConfig = vi.fn(async () => config)
  const createSession = vi.fn(async () => createSessionResult)
  const removeProvider = vi.fn(async (id: string) => {
    const { providers, ...rest } = config as { providers?: Record<string, unknown> } & Record<string, unknown>
    const next: KimiConfig = { ...rest } as KimiConfig
    const providersNext = { ...providers }
    delete providersNext[id]
    ;(next as { providers?: Record<string, unknown> }).providers = providersNext
    return next
  })
  const setConfig = vi.fn(async () => config)
  const replaceConfigSections = vi.fn(async () => {})
  const supportsAtomicSectionReplace = vi.fn(() => false)
  const resolveOAuthTokenProvider = vi.fn(() => ({ getAccessToken: async () => 'token-1' }))
  const harness = {
    getConfig,
    createSession,
    removeProvider,
    setConfig,
    replaceConfigSections,
    supportsAtomicSectionReplace,
    auth: { resolveOAuthTokenProvider },
  } as unknown as KimiHarness
  return {
    harness,
    mocks: {
      getConfig,
      createSession,
      removeProvider,
      setConfig,
      replaceConfigSections,
      supportsAtomicSectionReplace,
      resolveOAuthTokenProvider,
    },
  }
}

function makeSession(): Session {
  return {
    id: 'sess-1',
    summary: { title: 'My Session' },
    setModel: vi.fn(),
    setThinking: vi.fn(),
  } as unknown as Session
}

function setup(options?: {
  session?: Session
  engineV2?: boolean
  config?: KimiConfig
  startup?: Partial<KimiTUIOptions['startup']>
}): Harness {
  const store = createTui2Store({ workDir: '/ws' })
  const session = options && 'session' in options ? options.session : makeSession()
  const createdSession = makeSession()
  const { harness, mocks } = makeHarness(options?.config, createdSession)
  const tuiOptions: KimiTUIOptions = {
    initialAppState: { workDir: '/ws' } as never,
    startup: {
      continueLast: false,
      yolo: false,
      auto: false,
      plan: false,
      ...(options?.startup),
    },
  }
  const sessionEventHandler = {
    startSubscription: vi.fn(),
  } as unknown as SessionEventHandler

  const setAppState = vi.fn()
  const setStartupReady = vi.fn()
  const resetSessionRuntime = vi.fn()
  // `setSession` mutates the host's `session` reference, mirroring the real
  // runtime where the post-login session becomes the live session.
  const setSession = vi.fn(async (next: Session) => {
    currentSession = next
  })
  const syncRuntimeState = vi.fn(async () => {})
  const closeSession = vi.fn(async () => {})
  const appendStartupNotice = vi.fn()
  const hydrateLazyConfigDefaults = vi.fn(async () => {})
  const fetchSessions = vi.fn(async () => {})
  const updateTerminalTitle = vi.fn()
  const refreshSkillCommands = vi.fn(async () => {})
  const refreshPluginCommands = vi.fn(async () => {})

  let currentSession = session
  const host: AuthFlowHost = {
    store,
    get session() {
      return currentSession
    },
    harness,
    options: tuiOptions,
    engineV2: options?.engineV2 ?? false,
    setAppState,
    setStartupReady,
    resetSessionRuntime,
    setSession,
    syncRuntimeState,
    closeSession,
    appendStartupNotice,
    hydrateLazyConfigDefaults,
    sessionEventHandler,
    fetchSessions,
    updateTerminalTitle,
    refreshSkillCommands,
    refreshPluginCommands,
  }

  const controller = new AuthFlowController(host)
  return {
    controller,
    store,
    harness,
    mocks,
    session,
    createdSession,
    options: tuiOptions,
    setAppState,
    setStartupReady,
    resetSessionRuntime,
    setSession,
    syncRuntimeState,
    closeSession,
    appendStartupNotice,
    hydrateLazyConfigDefaults,
    fetchSessions,
    updateTerminalTitle,
    refreshSkillCommands,
    refreshPluginCommands,
    sessionEventHandler,
  }
}

describe('AuthFlowController.refreshAvailableModels', () => {
  it('reloads the config and writes models/providers into app state', async () => {
    const h = setup({ config: makeConfig() })

    await h.controller.refreshAvailableModels()

    expect(h.mocks.getConfig).toHaveBeenCalledWith({ reload: true })
    expect(h.setAppState).toHaveBeenCalledWith({
      availableModels: expect.objectContaining({ 'kimi-k2': expect.anything() }),
      availableProviders: expect.objectContaining({ moonshot: expect.anything() }),
    })
  })
})

describe('AuthFlowController.enterLoginRequiredStartupState', () => {
  it('resets runtime, clears the session app state, appends the OAuth notice, and marks startup ready', () => {
    const h = setup()

    h.controller.enterLoginRequiredStartupState()

    expect(h.resetSessionRuntime).toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    })
    expect(h.appendStartupNotice).toHaveBeenCalledWith(expect.any(String))
    expect(h.setStartupReady).toHaveBeenCalled()
  })
})

describe('AuthFlowController.activateModelAfterLogin', () => {
  it('sets the model (and effort) on the live session and returns early', async () => {
    const h = setup()
    const session = h.session as unknown as { setModel: ReturnType<typeof vi.fn>; setThinking: ReturnType<typeof vi.fn> }

    await h.controller.activateModelAfterLogin('kimi-k2', 'high')

    expect(session.setModel).toHaveBeenCalledWith('kimi-k2')
    expect(session.setThinking).toHaveBeenCalledWith('high')
    expect(h.mocks.createSession).not.toHaveBeenCalled()
  })

  it('session-less v2 configures the model only (lazy session creation)', async () => {
    const h = setup({ session: undefined, engineV2: true })

    await h.controller.activateModelAfterLogin('kimi-k2')

    expect(h.setAppState).toHaveBeenCalledWith({ model: 'kimi-k2' })
    expect(h.mocks.createSession).not.toHaveBeenCalled()
  })

  it('session-less v2 carries the effort as lazySessionThinking', async () => {
    const h = setup({ session: undefined, engineV2: true })

    await h.controller.activateModelAfterLogin('kimi-k2', 'high')

    expect(h.setAppState).toHaveBeenCalledWith({
      model: 'kimi-k2',
      thinkingEffort: 'high',
      lazySessionThinking: 'high',
    })
  })

  it('session-less v1 creates a session with the full startup options', async () => {
    const h = setup({
      session: undefined,
      engineV2: false,
      startup: { auto: true, agentProfile: 'coder', agentFiles: ['a.agent.md'] },
    })
    // planMode flows from the store state, not the startup flag.
    h.store.setState('planMode', true)

    await h.controller.activateModelAfterLogin('kimi-k2', 'high')

    expect(h.mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: '/ws',
        model: 'kimi-k2',
        thinking: 'high',
        permission: 'auto',
        planMode: true,
        agentProfile: 'coder',
        agentFiles: ['a.agent.md'],
      }),
    )
  })

  it('session-less v1 picks yolo permission and omits agentFiles when empty', async () => {
    const h = setup({
      session: undefined,
      engineV2: false,
      startup: { yolo: true, agentProfile: 'coder', agentFiles: [] },
    })

    await h.controller.activateModelAfterLogin('kimi-k2')

    const options = h.mocks.createSession.mock.calls[0]?.[0] as CreateSessionOptions
    expect(options.permission).toBe('yolo')
    expect(options.agentFiles).toBeUndefined()
  })

  it('session-less v1 leaves permission undefined without auto/yolo', async () => {
    const h = setup({ session: undefined, engineV2: false })

    await h.controller.activateModelAfterLogin('kimi-k2')

    const options = h.mocks.createSession.mock.calls[0]?.[0] as CreateSessionOptions
    expect(options.permission).toBeUndefined()
  })

  it('session-less v1 carries additionalDirs from the store', async () => {
    const h = setup({ session: undefined, engineV2: false })
    h.store.setState('additionalDirs', ['/extra'])

    await h.controller.activateModelAfterLogin('kimi-k2')

    const options = h.mocks.createSession.mock.calls[0]?.[0] as CreateSessionOptions
    expect(options.additionalDirs).toEqual(['/extra'])
  })

  it('session-less v1 wires the created session into the host and refreshes the shell', async () => {
    const h = setup({ session: undefined, engineV2: false })

    await h.controller.activateModelAfterLogin('kimi-k2')

    expect(h.setSession).toHaveBeenCalledWith(h.createdSession)
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', sessionTitle: 'My Session' }),
    )
    expect(h.syncRuntimeState).toHaveBeenCalledWith(h.createdSession)
    expect(h.sessionEventHandler.startSubscription).toHaveBeenCalled()
    expect(h.fetchSessions).toHaveBeenCalled()
    expect(h.updateTerminalTitle).toHaveBeenCalled()
    expect(h.refreshSkillCommands).toHaveBeenCalledWith(h.createdSession)
    expect(h.refreshPluginCommands).toHaveBeenCalledWith(h.createdSession)
  })
})

describe('AuthFlowController.clearActiveSessionAfterLogout', () => {
  it('closes the session, resets runtime, clears app state, and refreshes commands', async () => {
    const h = setup()

    await h.controller.clearActiveSessionAfterLogout()

    expect(h.closeSession).toHaveBeenCalledWith('logged out')
    expect(h.resetSessionRuntime).toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith({ sessionId: '', model: '', sessionTitle: null })
    expect(h.refreshSkillCommands).toHaveBeenCalledWith()
    expect(h.refreshPluginCommands).toHaveBeenCalledWith()
  })
})

describe('AuthFlowController.refreshConfigAfterLogin', () => {
  it('no default model + session-less v2 hydrates lazy defaults', async () => {
    const h = setup({ session: undefined, engineV2: true, config: makeConfig({ defaultModel: undefined }) })

    await h.controller.refreshConfigAfterLogin()

    expect(h.hydrateLazyConfigDefaults).toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ availableModels: expect.anything() }),
    )
    expect(h.mocks.createSession).not.toHaveBeenCalled()
  })

  it('default model missing from available models still hydrates (session-less v2)', async () => {
    const h = setup({ session: undefined, engineV2: true, config: makeConfig({ defaultModel: 'ghost' }) })

    await h.controller.refreshConfigAfterLogin()

    expect(h.hydrateLazyConfigDefaults).toHaveBeenCalled()
  })

  it('default model missing with a live session skips the hydration', async () => {
    const h = setup({ engineV2: true, config: makeConfig({ defaultModel: 'ghost' }) })

    await h.controller.refreshConfigAfterLogin()

    expect(h.hydrateLazyConfigDefaults).not.toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ availableModels: expect.anything() }),
    )
  })

  it('activates the default model with the configured thinking effort', async () => {
    const h = setup({
      session: undefined,
      engineV2: false,
      config: makeConfig({ defaultModel: 'kimi-k2', thinking: { enabled: true, effort: 'high' } }),
    })

    await h.controller.refreshConfigAfterLogin()

    expect(h.mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-k2', thinking: 'high' }),
    )
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-k2', maxContextTokens: 131072 }),
    )
  })

  it('session-less v2 also hydrates lazy defaults after activating the model', async () => {
    const h = setup({
      session: undefined,
      engineV2: true,
      config: makeConfig({ defaultModel: 'kimi-k2' }),
    })

    await h.controller.refreshConfigAfterLogin()

    expect(h.hydrateLazyConfigDefaults).toHaveBeenCalled()
    // Model activation wrote the model; the tail patch carries the lists only.
    expect(h.setAppState).toHaveBeenCalledWith({ model: 'kimi-k2' })
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ availableModels: expect.anything() }),
    )
  })

  it('activation with disabled thinking resolves effort to off', async () => {
    const h = setup({
      session: undefined,
      engineV2: false,
      config: makeConfig({ defaultModel: 'kimi-k2', thinking: { enabled: false } }),
    })

    await h.controller.refreshConfigAfterLogin()

    expect(h.mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-k2', thinking: 'off' }),
    )
  })
})

describe('AuthFlowController.refreshConfigAfterLogout', () => {
  it('reloads config and clears the model app state', async () => {
    const h = setup()

    await h.controller.refreshConfigAfterLogout()

    expect(h.mocks.getConfig).toHaveBeenCalledWith({ reload: true })
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({
        availableModels: expect.anything(),
        availableProviders: expect.anything(),
        model: '',
        thinkingEffort: 'off',
        maxContextTokens: 0,
        contextUsage: 0,
        contextTokens: 0,
      }),
    )
  })
})

describe('AuthFlowController.refreshProviderModels', () => {
  beforeEach(() => {
    refreshAllProviderModels.mockReset()
  })

  it('scopes the refresh to all providers and returns the result', async () => {
    const h = setup()
    refreshAllProviderModels.mockResolvedValue({ changed: [], removed: [] })

    const result = await h.controller.refreshProviderModels()

    expect(refreshAllProviderModels).toHaveBeenCalledWith(expect.anything(), { scope: 'all' })
    expect(result).toEqual({ changed: [], removed: [] })
    expect(h.mocks.getConfig).toHaveBeenCalledTimes(0)
  })

  it('scopes OAuth-only refresh and refreshes available models when providers changed', async () => {
    const h = setup()
    refreshAllProviderModels.mockResolvedValue({ changed: ['moonshot'], removed: [] })

    await h.controller.refreshOAuthProviderModels()

    expect(refreshAllProviderModels).toHaveBeenCalledWith(expect.anything(), { scope: 'oauth' })
    // changed.length > 0 → refreshAvailableModels runs a getConfig reload.
    expect(h.mocks.getConfig).toHaveBeenCalledWith({ reload: true })
  })

  it('skips the model refresh when nothing changed', async () => {
    const h = setup()
    refreshAllProviderModels.mockResolvedValue({ changed: [], removed: [] })

    await h.controller.refreshProviderModels()

    expect(h.mocks.getConfig).not.toHaveBeenCalled()
  })
})

describe('AuthFlowController refresh persistence host', () => {
  beforeEach(() => {
    refreshAllProviderModels.mockReset()
  })

  it('legacy host delegates getConfig/removeProvider/setConfig to the harness', async () => {
    const h = setup()
    refreshAllProviderModels.mockImplementation(async (host) => {
      await host.removeProvider('moonshot')
      await host.setConfig({ models: {} })
      return { changed: [], removed: [] }
    })

    await h.controller.refreshProviderModels()

    expect(h.mocks.removeProvider).toHaveBeenCalledWith('moonshot')
    expect(h.mocks.setConfig).toHaveBeenCalledWith({ models: {} })
    expect(h.mocks.replaceConfigSections).not.toHaveBeenCalled()
  })

  it('atomic host throws when setConfig is called before getConfig', async () => {
    const h = setup()
    h.mocks.supportsAtomicSectionReplace.mockReturnValue(true)
    refreshAllProviderModels.mockImplementation(async (host) => {
      await host.setConfig({})
      return { changed: [], removed: [] }
    })

    await expect(h.controller.refreshProviderModels()).rejects.toThrow(
      'refresh host: getConfig must be called before writes',
    )
  })

  it('atomic host stages removal in memory and persists complete records in one write', async () => {
    const h = setup()
    h.mocks.supportsAtomicSectionReplace.mockReturnValue(true)
    let stagedConfig: KimiConfig | undefined
    refreshAllProviderModels.mockImplementation(async (host) => {
      const config = await host.getConfig()
      stagedConfig = await host.removeProvider('moonshot')
      await host.setConfig({ models: config.models })
      return { changed: [], removed: ['moonshot'] }
    })

    await h.controller.refreshProviderModels()

    // The removal is staged in memory only — the harness removeProvider never ran.
    expect(h.mocks.removeProvider).not.toHaveBeenCalled()
    // The single atomic write persists the complete records (removal + models).
    expect(h.mocks.replaceConfigSections).toHaveBeenCalledWith(
      expect.objectContaining({ models: expect.anything() }),
    )
    // stagedConfig excludes the removed provider.
    const providers = (stagedConfig as { providers?: Record<string, unknown> }).providers
    expect(providers).not.toHaveProperty('moonshot')
  })

  it('atomic host resolves OAuth tokens through the harness auth provider', async () => {
    const h = setup()
    h.mocks.supportsAtomicSectionReplace.mockReturnValue(true)
    let token: string | undefined
    refreshAllProviderModels.mockImplementation(async (host) => {
      token = await host.resolveOAuthToken('moonshot', { ref: 'x' } as never)
      return { changed: [], removed: [] }
    })

    await h.controller.refreshProviderModels()

    expect(token).toBe('token-1')
    expect(h.mocks.resolveOAuthTokenProvider).toHaveBeenCalledWith('moonshot', { ref: 'x' })
  })
})
