import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { IKaosFactory, KaosFactory } from '#/kaos';

describe('KaosFactory', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      IKaosFactory,
      KaosFactory,
      InstantiationType.Delayed,
      'kaos',
    );
  });

  it('createLocal builds an IKaos rooted at the given cwd', async () => {
    const host = createScopedTestHost();
    const factory = host.core.accessor.get(IKaosFactory);
    const k = await factory.createLocal(process.cwd());

    expect(k.name).toBe('local');
    expect(k.getcwd()).toBe(process.cwd());
    expect(k.cwd).toBe(process.cwd());
    expect(['posix', 'win32']).toContain(k.pathClass());
    expect(typeof k.osEnv.osKind).toBe('string');
    expect(typeof k.osEnv.shellPath).toBe('string');

    host.dispose();
  });

  it('withCwd derives an independent env without mutating the parent', async () => {
    const host = createScopedTestHost();
    const factory = host.core.accessor.get(IKaosFactory);
    const k = await factory.createLocal('/tmp');

    const child = k.withCwd('/var');
    expect(child.getcwd()).toBe('/var');
    expect(k.getcwd()).toBe('/tmp');

    host.dispose();
  });

  it('backend delegates fs operations to the kaos backend', async () => {
    const host = createScopedTestHost();
    const factory = host.core.accessor.get(IKaosFactory);
    const k = await factory.createLocal(process.cwd());

    const st = await k.backend.stat(process.cwd());
    expect(typeof st.stSize).toBe('number');

    host.dispose();
  });
});
