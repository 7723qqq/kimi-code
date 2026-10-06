import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleSpecCommand } from '#/tui/commands/index';

function makeHost(
  overrides: {
    hasSession?: boolean;
    specMode?: boolean;
    /** The engine refuses to change mode, so status never reflects the request. */
    engineRefuses?: boolean;
    /** The confirm read rejects, so the command cannot verify the switch. */
    statusReadFails?: boolean;
  } = {},
) {
  let engineMode = overrides.specMode ?? false;
  const session = {
    setSpecMode: vi.fn(async (enabled: boolean) => {
      if (!overrides.engineRefuses) engineMode = enabled;
    }),
    getSpec: vi.fn(async () => (engineMode ? { dir: '/ws/specs/spec-1' } : null)),
    getStatus: vi.fn(async () => {
      if (overrides.statusReadFails) throw new Error('status unavailable');
      return { specMode: engineMode };
    }),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        specMode: overrides.specMode ?? false,
        model: 'test-model',
      },
    },
    session: hasSession ? session : undefined,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleSpecCommand — confirms the mode actually took', () => {
  it('shows the spec directory when entering spec mode succeeds', async () => {
    const { host } = makeHost();

    await handleSpecCommand(host, 'on');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({ specMode: true });
  });

  it('reports an error when the engine refuses the entry', async () => {
    const { host } = makeHost({ engineRefuses: true });

    await handleSpecCommand(host, 'on');

    // Reporting `Spec mode: ON` here would leave the footer and the engine
    // disagreeing, which is exactly what `/tower` guards against.
    expect(host.showError).toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({ specMode: false });
  });

  it('reports an error when the engine refuses to leave spec mode', async () => {
    const { host } = makeHost({ specMode: true, engineRefuses: true });

    await handleSpecCommand(host, 'off');

    expect(host.showError).toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({ specMode: true });
  });

  it('re-leaves spec mode from app state when the engine already left it', async () => {
    const { host, session } = makeHost({ specMode: true });

    await handleSpecCommand(host, 'off');

    expect(session.setSpecMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ specMode: false });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('leaves spec mode when the confirm read fails', async () => {
    const { host, session } = makeHost({ specMode: true, statusReadFails: true });

    await handleSpecCommand(host, 'off');

    // A read we could not perform is not evidence that the engine refused, and
    // it must not strand the UI on a mode the engine has already left.
    expect(session.setSpecMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ specMode: false });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('enters spec mode when the confirm read fails', async () => {
    const { host } = makeHost({ statusReadFails: true });

    await handleSpecCommand(host, 'on');

    expect(host.setAppState).toHaveBeenCalledWith({ specMode: true });
    expect(host.showError).not.toHaveBeenCalled();
  });
});
