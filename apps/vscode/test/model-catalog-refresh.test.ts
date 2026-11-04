import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { startModelCatalogRefresh } from '../src/runtime/model-catalog-refresh';

interface HarnessStub {
  readonly harness: Pick<KimiHarness, 'getConfig' | 'refreshProviderModels'>;
  readonly refreshCalls: number;
}

function harnessStub(options: {
  readonly changed?: readonly unknown[];
  readonly failed?: readonly unknown[];
  readonly refreshIntervalMs?: number;
  readonly refreshOnStart?: boolean;
  readonly reject?: unknown;
}): HarnessStub {
  const state = { refreshCalls: 0 };
  return {
    get refreshCalls(): number {
      return state.refreshCalls;
    },
    harness: {
      getConfig: async () =>
        ({
          modelCatalog: {
            refreshIntervalMs: options.refreshIntervalMs,
            refreshOnStart: options.refreshOnStart,
          },
        }) as never,
      refreshProviderModels: async () => {
        state.refreshCalls += 1;
        if (options.reject !== undefined) throw options.reject;
        return {
          changed: options.changed ?? [],
          unchanged: [],
          failed: options.failed ?? [],
        } as never;
      },
    } as Pick<KimiHarness, 'getConfig' | 'refreshProviderModels'>,
  } as HarnessStub;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

describe('startModelCatalogRefresh', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('refreshes on start and reports only a catalog that actually changed', async () => {
    const stub = harnessStub({ changed: [{ provider_id: 'p' }], refreshIntervalMs: 0 });
    const onChanged = mock(() => {});
    dispose = startModelCatalogRefresh({
      harness: stub.harness,
      onChanged,
      log: () => {},
      env: {},
    });

    await flush();

    expect(stub.refreshCalls).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the refresh changes nothing', async () => {
    const stub = harnessStub({ refreshIntervalMs: 0 });
    const onChanged = mock(() => {});
    dispose = startModelCatalogRefresh({
      harness: stub.harness,
      onChanged,
      log: () => {},
      env: {},
    });

    await flush();

    expect(stub.refreshCalls).toBe(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('skips the start refresh when disabled and stops after dispose', async () => {
    const stub = harnessStub({ refreshOnStart: false, refreshIntervalMs: 0 });
    const onChanged = mock(() => {});
    dispose = startModelCatalogRefresh({
      harness: stub.harness,
      onChanged,
      log: () => {},
      env: {},
    });

    await flush();
    expect(stub.refreshCalls).toBe(0);

    dispose();
    dispose = undefined;
    await flush();
    expect(stub.refreshCalls).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('lets the environment disable the start refresh over the config value', async () => {
    const stub = harnessStub({ refreshOnStart: true, refreshIntervalMs: 0 });
    dispose = startModelCatalogRefresh({
      harness: stub.harness,
      onChanged: () => {},
      log: () => {},
      env: { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: 'false' },
    });

    await flush();

    expect(stub.refreshCalls).toBe(0);
  });

  it('logs a failed refresh instead of throwing', async () => {
    const stub = harnessStub({ refreshIntervalMs: 0, reject: new Error('catalog unavailable') });
    const log = mock(() => {});
    dispose = startModelCatalogRefresh({
      harness: stub.harness,
      onChanged: () => {},
      log,
      env: {},
    });

    await flush();

    expect(stub.refreshCalls).toBe(1);
    expect(log).toHaveBeenCalledWith('Model catalog refresh failed', expect.anything());
  });
});
