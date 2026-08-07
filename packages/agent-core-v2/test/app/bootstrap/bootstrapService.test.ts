import { beforeEach, describe, expect, it } from 'vitest';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapOptions,
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubClientIdentity } from './stubs';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IBootstrapService,
      BootstrapService,
      ScopeActivation.OnScopeCreated,
      'bootstrap',
    );
  });

  it('resolves homeDir/configPath from the seeded context token', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.homeDir).toBe('/tmp/kimi-home');
    expect(svc.configPath).toBe('/tmp/kimi-home/config.toml');
    expect(svc.scope('sessions')).toBe('sessions');
    host.dispose();
  });

  it('exposes the seeded client identity', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.clientIdentity).toEqual(stubClientIdentity);
    host.dispose();
  });

  it('getEnv reads from the seeded env bag', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ env: { FOO: 'bar' }, clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('FOO')).toBe('bar');
    expect(svc.getEnv('MISSING')).toBeUndefined();
    host.dispose();
  });

  it('getEnv returns empty string for an explicitly empty value', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ env: { EMPTY_VAR: '' }, clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('EMPTY_VAR')).toBe('');
    host.dispose();
  });

  it('getEnv handles special characters in env values', () => {
    const host = createScopedTestHost(
      bootstrapSeed({
        env: { PATH: '/usr/bin:/bin', SPECIAL: 'a=b&c<d>e|f' },
        clientIdentity: stubClientIdentity,
      }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('PATH')).toBe('/usr/bin:/bin');
    expect(svc.getEnv('SPECIAL')).toBe('a=b&c<d>e|f');
    host.dispose();
  });
});

describe('resolveBootstrapOptions', () => {
  it('prefers explicit homeDir over KIMI_CODE_HOME over osHomeDir', () => {
    expect(
      resolveBootstrapOptions({ homeDir: '/a', osHomeDir: '/b', env: {}, clientIdentity: stubClientIdentity })
        .homeDir,
    ).toBe('/a');
    expect(
      resolveBootstrapOptions({
        osHomeDir: '/b',
        env: { KIMI_CODE_HOME: '/c' },
        clientIdentity: stubClientIdentity,
      }).homeDir,
    ).toBe('/c');
    expect(
      resolveBootstrapOptions({ osHomeDir: '/b', env: {}, clientIdentity: stubClientIdentity }).homeDir,
    ).toBe('/b/.kimi-code');
  });

  it('passes through an explicit clientIdentity', () => {
    expect(
      resolveBootstrapOptions({ env: {}, clientIdentity: stubClientIdentity }).clientIdentity,
    ).toEqual(stubClientIdentity);
  });

  it('uses explicit homeDir even when KIMI_CODE_HOME is also set', () => {
    expect(
      resolveBootstrapOptions({
        homeDir: '/explicit',
        osHomeDir: '/home/user',
        env: { KIMI_CODE_HOME: '/env/kimi' },
        clientIdentity: stubClientIdentity,
      }).homeDir,
    ).toBe('/explicit');
  });

  it('falls through to osHomeDir/.kimi-code when nothing is provided', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/home/user', env: {}, clientIdentity: stubClientIdentity })
        .homeDir,
    ).toBe('/home/user/.kimi-code');
  });

  it('handles empty osHomeDir gracefully', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '', env: {}, clientIdentity: stubClientIdentity }).homeDir,
    ).toBe('.kimi-code');
  });
});

describe('bootstrap() storage seeding', () => {
  it('seeds IFileSystemStorageService as a FileStorageService instance', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity });
    try {
      const storage = app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      app.dispose();
    }
  });

  it('passes the env bag through to the resolved BootstrapService', () => {
    const { app } = bootstrap({
      homeDir: '/tmp/kimi-env',
      env: { MY_VAR: 'my-value' },
      clientIdentity: stubClientIdentity,
    });
    try {
      expect(app.accessor.get(IBootstrapService).getEnv('MY_VAR')).toBe('my-value');
    } finally {
      app.dispose();
    }
  });

  it('passes an empty homeDir through as-is (empty string is not nullish)', () => {
    const { app } = bootstrap({ homeDir: '', clientIdentity: stubClientIdentity });
    try {
      expect(app.accessor.get(IBootstrapService).homeDir).toBe('');
    } finally {
      app.dispose();
    }
  });
});

describe('bootstrapSeed', () => {
  it('returns a single seed entry keyed on the IBootstrapOptions identifier', () => {
    const seed = bootstrapSeed({ homeDir: '/tmp/kimi-seed', clientIdentity: stubClientIdentity });
    expect(seed).toHaveLength(1);
    const [id, value] = seed[0]!;
    expect(id).toBe(IBootstrapOptions);
    expect(value).toEqual(
      resolveBootstrapOptions({ homeDir: '/tmp/kimi-seed', clientIdentity: stubClientIdentity }),
    );
  });

  it('resolves the same value as resolveBootstrapOptions for the same input', () => {
    const input: Parameters<typeof bootstrapSeed>[0] = {
      homeDir: '/tmp/kimi-seed-eq',
      osHomeDir: '/home/user',
      env: { X: 'y' },
      clientIdentity: stubClientIdentity,
    };
    const seed = bootstrapSeed(input);
    expect(seed[0]![1]).toEqual(resolveBootstrapOptions(input));
  });
});

describe('resolveBootstrapOptions — BootstrapInput field coverage', () => {
  it('falls back to process.platform when platform is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {}, clientIdentity: stubClientIdentity }).platform).toBe(process.platform);
  });

  it('falls back to process.arch when arch is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {}, clientIdentity: stubClientIdentity }).arch).toBe(process.arch);
  });

  it('falls back to process.cwd() when cwd is omitted', () => {
    expect(resolveBootstrapOptions({ osHomeDir: '/h', env: {}, clientIdentity: stubClientIdentity }).cwd).toBe(process.cwd());
  });

  it('preserves an explicit platform value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, platform: 'linux', clientIdentity: stubClientIdentity }).platform,
    ).toBe('linux');
  });

  it('preserves an explicit arch value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, arch: 'arm64', clientIdentity: stubClientIdentity }).arch,
    ).toBe('arm64');
  });

  it('preserves an explicit cwd value', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', env: {}, cwd: '/work', clientIdentity: stubClientIdentity }).cwd,
    ).toBe('/work');
  });

  it('preserves an explicit configPath instead of joining homeDir/config.toml', () => {
    expect(
      resolveBootstrapOptions({
        homeDir: '/x',
        configPath: '/custom/config.toml',
        env: {},
        clientIdentity: stubClientIdentity,
      }).configPath,
    ).toBe('/custom/config.toml');
  });

  it('returns process.env by reference when env is omitted', () => {
    expect(
      resolveBootstrapOptions({ osHomeDir: '/h', clientIdentity: stubClientIdentity }).env,
    ).toBe(process.env);
  });

  it('accepts a BootstrapInput with every field populated', () => {
    const full = resolveBootstrapOptions({
      homeDir: '/full',
      configPath: '/full/cfg.toml',
      env: { K: 'v' },
      osHomeDir: '/home/full',
      platform: 'darwin',
      arch: 'x64',
      cwd: '/full/cwd',
      clientIdentity: stubClientIdentity,
    });
    expect(full).toEqual({
      homeDir: '/full',
      configPath: '/full/cfg.toml',
      osHomeDir: '/home/full',
      platform: 'darwin',
      arch: 'x64',
      cwd: '/full/cwd',
      env: { K: 'v' },
      clientIdentity: stubClientIdentity,
      args: {
        agentFiles: undefined,
        skillDirs: undefined,
        requestHeaders: {},
        displayName: undefined,
        replyStyleGuide: undefined,
      },
    });
  });
});

describe('bootstrap() — BootstrapResult', () => {
  interface IExtraProbe {
    readonly _serviceBrand: undefined;
    readonly tag: 'extra-seed';
  }

  const IExtraProbe: ServiceIdentifier<IExtraProbe> =
    createDecorator<IExtraProbe>('bootstrap-extra-probe');

  it('returns a BootstrapResult exposing a usable app Scope', () => {
    const result = bootstrap({ homeDir: '/tmp/kimi-result', clientIdentity: stubClientIdentity });
    expect(result).toHaveProperty('app');
    try {
      const storage = result.app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      result.app.dispose();
    }
  });

  it('returned app provides accessor.get and dispose', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-result-shape', clientIdentity: stubClientIdentity });
    try {
      expect(typeof app.accessor.get).toBe('function');
      expect(typeof app.dispose).toBe('function');
    } finally {
      app.dispose();
    }
  });

  it('app.dispose() releases the scope without throwing', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-result-dispose', clientIdentity: stubClientIdentity });
    expect(() => app.dispose()).not.toThrow();
  });

  it('runs with no arguments and resolves a default homeDir', () => {
    const { app } = bootstrap({ clientIdentity: stubClientIdentity });
    try {
      const svc = app.accessor.get(IBootstrapService);
      expect(typeof svc.homeDir).toBe('string');
      expect(svc.homeDir.length).toBeGreaterThan(0);
    } finally {
      app.dispose();
    }
  });

  it('honors extraSeeds alongside the default seeds', () => {
    const extra: IExtraProbe = { _serviceBrand: undefined, tag: 'extra-seed' };
    const { app } = bootstrap(
      { homeDir: '/tmp/kimi-extra', clientIdentity: stubClientIdentity },
      [[IExtraProbe as ServiceIdentifier<unknown>, extra]],
    );
    try {
      expect(app.accessor.get(IExtraProbe).tag).toBe('extra-seed');
    } finally {
      app.dispose();
    }
  });

  it('still seeds the default services when extraSeeds is empty', () => {
    const { app } = bootstrap(
      { homeDir: '/tmp/kimi-empty-extra', clientIdentity: stubClientIdentity },
      [],
    );
    try {
      expect(app.accessor.get(IFileSystemStorageService)).toBeInstanceOf(FileStorageService);
      expect(app.accessor.get(IBootstrapService).homeDir).toBe('/tmp/kimi-empty-extra');
    } finally {
      app.dispose();
    }
  });
});
