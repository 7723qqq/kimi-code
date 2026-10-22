import type {
  IConfigService,
  IProviderDiscoveryService,
  ModelCatalogConfig,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ModelCatalogRefreshScheduler } from '../src/services/modelCatalog/modelCatalogRefreshScheduler';
import type { ServerLogger } from '../src/services/pinoLoggerService';
import { createFakeClock } from './helpers/fakeClock';
import { restoreEnvs } from './helpers/stubs';
import { waitForAssertion } from './helpers/waitFor';

const EMPTY_RESULT = { changed: [], unchanged: [], failed: [] };

function makeCatalog(refreshProviderModels = mock(async () => EMPTY_RESULT)) {
  return { refreshProviderModels } as unknown as IProviderDiscoveryService;
}

function makeConfig(catalogConfig?: ModelCatalogConfig): IConfigService {
  return {
    ready: Promise.resolve(),
    get: mock((domain: string) => (domain === 'modelCatalog' ? catalogConfig : undefined)),
  } as unknown as IConfigService;
}

function makeLogger(): Pick<ServerLogger, 'info' | 'warn'> {
  return {
    info: mock(),
    warn: mock(),
  };
}

describe('ModelCatalogRefreshScheduler', () => {
  afterEach(() => {
    restoreEnvs();
  });

  it('refreshes on start and then on the configured interval', async () => {
    const clock = createFakeClock();
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig(),
      makeLogger(),
      {},
      clock,
    );

    await scheduler.start();
    await waitForAssertion(() => {
      expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
    });
    expect(catalog.refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });

    await clock.advanceAsync(6 * 60 * 60 * 1000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    await clock.advanceAsync(6 * 60 * 60 * 1000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);
  });

  it('honors env overrides for interval and refresh-on-start', async () => {
    const clock = createFakeClock();
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig(),
      makeLogger(),
      {
        KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
        KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
      },
      clock,
    );

    await scheduler.start();
    await clock.advanceAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();

    await clock.advanceAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('reads interval and refresh-on-start from the modelCatalog config section', async () => {
    const clock = createFakeClock();
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 1000, refreshOnStart: false }),
      makeLogger(),
      {},
      clock,
    );

    await scheduler.start();
    await clock.advanceAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
    await clock.advanceAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('lets env override the modelCatalog config section', async () => {
    const clock = createFakeClock();
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 6 * 60 * 60 * 1000, refreshOnStart: true }),
      makeLogger(),
      {
        KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
        KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
      },
      clock,
    );

    await scheduler.start();
    await clock.advanceAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
    await clock.advanceAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('disables the schedule when the config interval is 0', async () => {
    const clock = createFakeClock();
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 0, refreshOnStart: false }),
      makeLogger(),
      {},
      clock,
    );

    await scheduler.start();
    await clock.advanceAsync(60 * 1000);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('swallows refresh errors so a failing tick does not break the schedule', async () => {
    const clock = createFakeClock();
    const refreshProviderModels = mock().mockRejectedValue(new Error('network down'));
    const catalog = makeCatalog(refreshProviderModels);
    const logger = makeLogger();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig(),
      logger,
      {
        KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
        KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: 'false',
      },
      clock,
    );

    await scheduler.start();
    await clock.advanceAsync(1000);
    await clock.advanceAsync(1000);

    expect(refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
