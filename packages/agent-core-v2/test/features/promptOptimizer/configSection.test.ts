import { beforeEach, describe, expect, it } from 'bun:test';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { PROMPT_OPTIMIZER_SECTION } from '#/features/promptOptimizer/configSection';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import '#/features/promptOptimizer/configSection';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

describe('[prompt_optimizer] diagnostics', () => {
  let disposables: DisposableStore;

  function makeConfig(toml: string) {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    return { config, ready: config.ready };
  }

  beforeEach(() => {
    disposables?.dispose();
  });

  it('warns on an effort the rewrite does not recognize, instead of silently following the main agent', async () => {
    const { config, ready } = makeConfig('[prompt_optimizer]\neffort = "ultra"\n');
    await ready;

    expect(config.diagnostics()).toContainEqual({
      domain: PROMPT_OPTIMIZER_SECTION,
      severity: 'warning',
      message: expect.stringContaining("[prompt_optimizer] effort 'ultra' is not a thinking level"),
    });
  });

  it('accepts every documented effort level without a warning', async () => {
    const { config, ready } = makeConfig(
      '[prompt_optimizer]\neffort = "high"\ntimeout_ms = 120000\n',
    );
    await ready;

    expect(config.diagnostics()).toEqual([]);
    expect(config.get<{ effort?: string; timeoutMs?: number }>(PROMPT_OPTIMIZER_SECTION)).toEqual({
      effort: 'high',
      timeoutMs: 120000,
    });
  });

  it('stays silent when the section is absent or the effort is unset', async () => {
    const absent = makeConfig('');
    await absent.ready;
    expect(absent.config.diagnostics()).toEqual([]);
    expect(absent.config.get(PROMPT_OPTIMIZER_SECTION)).toEqual({ timeoutMs: 180000 });

    const unset = makeConfig('[prompt_optimizer]\ntimeout_ms = 150000\n');
    await unset.ready;
    expect(unset.config.diagnostics()).toEqual([]);
    expect(unset.config.get(PROMPT_OPTIMIZER_SECTION)).toEqual({ timeoutMs: 150000 });
  });
});
