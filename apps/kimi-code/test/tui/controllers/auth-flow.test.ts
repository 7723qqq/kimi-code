import { afterEach, describe, expect, it, mock, type Mock } from 'bun:test';

import { AuthFlowController, type AuthFlowHost } from '#/tui/controllers/auth-flow';
import {
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
} from '#/utils/model-switch-confirm-config';
import { waitForAssertion } from '#test/helpers/waitFor';

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

describe('refreshConfigAfterLogin with a matching cloud rule', () => {
  afterEach(() => {
    resetModelSwitchConfirmConfigCache();
  });

  async function makeGateHost() {
    const { host, session, appState } = makeHost({ withSession: true, defaultModel: 'k2' });
    (appState as Record<string, unknown>)['streamingPhase'] = 'idle';
    host.harness.getConfig = mock(async () => ({
      defaultModel: 'k2',
      models: {
        'old-model': { provider: 'managed:kimi-code', model: 'upstream-old', maxContextSize: 200_000 },
        k2: { provider: 'managed:kimi-code', model: 'upstream-new', maxContextSize: 200_000 },
      },
      providers: {},
    }));
    (host as unknown as { state: Record<string, unknown> }).state['transcriptEntries'] = [
      { kind: 'user', bullet: 'hi' },
    ];
    const mountEditorReplacement = mock();
    (host as unknown as Record<string, unknown>)['mountEditorReplacement'] = mountEditorReplacement;
    (host as unknown as Record<string, unknown>)['restoreEditor'] = mock();
    (host as unknown as Record<string, unknown>)['showStatus'] = mock();
    (host as unknown as Record<string, unknown>)['showError'] = mock();
    (host as unknown as Record<string, unknown>)['showNotice'] = mock();
    (host as unknown as Record<string, unknown>)['track'] = mock();
    await refreshModelSwitchConfirmConfig({
      fetchImpl: mock(
        async () =>
          new Response(
            JSON.stringify({
              name: 'model_switch_confirm',
              config: {
                enable: true,
                rules: [{ from: 'upstream-old', to: 'upstream-new' }],
              },
            }),
          ),
      ) as unknown as unknown as typeof fetch,
    });
    return { host, session, appState, mountEditorReplacement };
  }

  it('gates the activation through the confirmation dialog and skips setModel', async () => {
    const { host, session, mountEditorReplacement } = await makeGateHost();

    const result = await new AuthFlowController(host).refreshConfigAfterLogin();

    expect(result).toBe('gated');
    expect(session!.setModel).not.toHaveBeenCalled();
    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
  });

  it('gates an alias introduced by this login that the stale catalog lacks', async () => {
    const { host, session, appState, mountEditorReplacement } = await makeGateHost();
    // The pre-refresh catalog knows nothing about k2 — only the freshly loaded
    // config introduces it, so the match must run against the new catalog.
    (appState as Record<string, unknown>)['availableModels'] = {
      'old-model': { model: 'upstream-old', displayName: 'Old' },
    };

    const result = await new AuthFlowController(host).refreshConfigAfterLogin();

    expect(result).toBe('gated');
    expect(session!.setModel).not.toHaveBeenCalled();
    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
  });

  it('forwards the caller picked effort to the gated dialog', async () => {
    const { host, session, mountEditorReplacement } = await makeGateHost();

    const result = await new AuthFlowController(host).refreshConfigAfterLogin('max');

    expect(result).toBe('gated');
    const dialog = mountEditorReplacement.mock.calls[0]?.[0] as unknown as {
      opts: { onSelect: (action: string) => void };
    };
    dialog.opts.onSelect('continue');
    await waitForAssertion(() => expect(session!.setThinking).toHaveBeenCalledWith('max'));
  });
});
