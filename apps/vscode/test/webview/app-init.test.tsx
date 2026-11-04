import './setup';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { act, renderHook, waitFor } from '@testing-library/react';

import { useAppInit } from '@/hooks/useAppInit';
import { useSettingsStore } from '@/stores';

const model = (name: string) => ({
  name,
  display_name: name,
  provider: 'kimi',
  provider_type: 'kimi',
  max_context_size: 128_000,
  capabilities: [],
  support_efforts: [],
  default_effort: null,
});

const handlers = new Map<string, () => void>();
const getModels = mock();
const unsubscribe = mock(() => {});

void mock.module('@/services', () => ({
  Events: {
    ModelCatalogChanged: 'modelCatalogChanged',
    ExtensionConfigChanged: 'extensionConfigChanged',
  },
  bridge: {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return unsubscribe;
    },
    checkWorkspace: async () => ({ hasWorkspace: true, workspaceRoot: '/repo' }),
    getExtensionConfig: async () => ({ theme: 'dark', changedKeys: [] }),
    getSlashCommands: async () => [],
    checkLoginStatus: async () => ({ loggedIn: true }),
    getModels,
  },
}));

describe('useAppInit model catalog refresh', () => {
  beforeEach(() => {
    handlers.clear();
    getModels.mockReset();
    unsubscribe.mockClear();
    getModels.mockImplementation(async () => ({
      models: [model('boot-model')],
      defaultModel: 'boot-model',
      defaultThinking: false,
      defaultThinkingEffort: undefined,
    }));
    useSettingsStore.setState({ models: [] });
  });

  it('applies a refreshed catalog broadcast by the extension', async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    getModels.mockImplementation(async () => ({
      models: [model('refreshed-model')],
      defaultModel: 'refreshed-model',
      defaultThinking: false,
      defaultThinkingEffort: undefined,
    }));

    await act(async () => {
      handlers.get('modelCatalogChanged')?.();
    });

    await waitFor(() =>
      expect(useSettingsStore.getState().models.map((entry) => entry.name)).toEqual([
        'refreshed-model',
      ]),
    );
  });

  it('unsubscribes when the hook unmounts', async () => {
    const { result, unmount } = renderHook(() => useAppInit());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
