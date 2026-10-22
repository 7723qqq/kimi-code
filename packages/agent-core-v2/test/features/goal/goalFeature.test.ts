import { beforeEach, describe, expect, it } from 'bun:test';

import { ScopeActivation } from '#/_base/di/instantiation';
import { _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';

import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';

import { LifecycleScope } from '#/app/scopes';

import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { GoalFeature } from '#/features/goal/goalFeature';

describe('GoalFeature', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(GoalFeature);
  });

  it('assembles a named, introspectable goal unit', () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toContain('goal');
    host.dispose();
  });

  it('retracts the goal runtime contribution with the Feature', async () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);

    await manager.unprovideUnit('goal');
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).not.toContain('goal');

    manager.provideUnit(GoalFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).toContain('goal');

    host.dispose();
  });
});
