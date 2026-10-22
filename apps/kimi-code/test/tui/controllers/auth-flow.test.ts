import { describe, expect, it, mock, type Mock } from 'bun:test';

import { AuthFlowController, type AuthFlowHost } from '#/tui/controllers/auth-flow';

function makeHost(
  options: {
    withSession?: boolean;
    defaultModel?: string;
    boundModel?: string;
  } = {},
) {
  const appState = {
    workDir: '/tmp/work',
    additionalDirs: [] as string[],
    planMode: false,
    model: 'old-model',
    thinkingEffort: 'off',
  };
  const session =
    options.withSession === true
      ? {
          id: 'ses-live',
          getStatus: mock(async () => ({ model: options.boundModel ?? 'old-model' })),
          setModel: mock(async () => ({ model: 'k2', providerName: 'managed' })),
          setThinking: mock(async () => {}),
        }
      : undefined;
  const host = {
    state: { appState },
    session,
    harness: {
      createSession: mock(async () => ({ id: 'ses-new', summary: { title: null } })),
      getConfig: mock(async () => ({
        defaultModel: options.defaultModel,
        models: {
          k2: { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 200_000 },
        },
        providers: {},
      })),
    },
    options: { startup: {} },
    setAppState: mock((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    setStartupReady: mock(),
    resetSessionRuntime: mock(),
    setSession: mock(async (next: unknown) => {
      (host as { session: unknown }).session = next;
    }),
    syncRuntimeState: mock(async () => {}),
    appendStartupNotice: mock(),
    hydrateLazyConfigDefaults: mock(async () => {}),
    sessionEventHandler: { startSubscription: mock() },
    fetchSessions: mock(async () => {}),
    updateTerminalTitle: mock(),
    refreshSkillCommands: mock(async () => {}),
    refreshPluginCommands: mock(async () => {}),
  } as unknown as AuthFlowHost & {
    session: unknown;
    harness: {
      createSession: Mock<(...args: any[]) => any>;
      getConfig: Mock<(...args: any[]) => any>;
    };
    setAppState: Mock<(...args: any[]) => any>;
  };
  return { host, appState, session };
}

describe('activateModelAfterLogin', () => {
  it('reports an engine-tracked switch when the pick changes the bound alias', async () => {
    const { host, session } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(true);
    expect(session!.setModel).toHaveBeenCalledWith('k2');
    expect(session!.setThinking).toHaveBeenCalledWith('high');
  });

  it('reports no engine switch when the live session already binds the alias', async () => {
    const { host, session } = makeHost({ withSession: true, boundModel: 'k2' });
    const authFlow = new AuthFlowController(host);

    // setModel is an alias no-op here, so neither engine emits model_switch —
    // callers must stay the producer. The effort still goes through
    // setThinking, whose thinking_toggle is the engine's own event.
    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(false);
    expect(session!.setModel).toHaveBeenCalledWith('k2');
    expect(session!.setThinking).toHaveBeenCalledWith('high');
  });

  it('only patches app state and reports no engine switch on the session-less v2 path', async () => {
    const { host, appState } = makeHost();
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(false);
    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect(appState.model).toBe('k2');
    expect(appState).toMatchObject({ lazySessionThinking: 'high' });
  });
});

describe('refreshConfigAfterLogin', () => {
  it('reports false without activating when no default model is configured', async () => {
    const { host } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.refreshConfigAfterLogin();

    expect(engineTrackedSwitch).toBe(false);
  });

  it('propagates the activation result for the persisted default model', async () => {
    const live = makeHost({ withSession: true, defaultModel: 'k2' });
    const reachedLive = await new AuthFlowController(live.host).refreshConfigAfterLogin();
    expect(reachedLive).toBe(true);
    expect(live.session!.setModel).toHaveBeenCalledWith('k2');

    const lazy = makeHost({ defaultModel: 'k2' });
    const reachedLazy = await new AuthFlowController(lazy.host).refreshConfigAfterLogin();
    expect(reachedLazy).toBe(false);
    expect(lazy.host.harness.createSession).not.toHaveBeenCalled();
  });
});

describe('refreshConfigAfterLogout', () => {
  it('clears the active model on a live session when the removed provider owned it and no default remains', async () => {
    const { host, appState } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    await authFlow.refreshConfigAfterLogout();

    expect(appState.model).toBe('');
    expect(appState.thinkingEffort).toBe('off');
  });

  it('activates the fallback default model on a live session when the active model was removed', async () => {
    const { host, appState, session } = makeHost({ withSession: true, defaultModel: 'k2' });
    const authFlow = new AuthFlowController(host);

    await authFlow.refreshConfigAfterLogout();

    expect(session!.setModel).toHaveBeenCalledWith('k2');
    expect(appState.model).toBe('k2');
  });
});
