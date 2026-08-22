import { beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import { _clearScopedRegistryForTests, registerScopedService, type Scope } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { LSP_FLAG_ID } from '#/features/lsp/flag';
import { ILspService } from '#/features/lsp/lsp';
import { LspFeature } from '#/features/lsp/lspFeature';
import { ILspStdioProviderService } from '#/features/lsp/lspStdioProvider';

import { stubFlag } from '../../app/flag/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('LspFeature — experimental flag gating', () => {
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
    registerFeature(LspFeature);
  });

  it('assembles an empty unit when the lsp flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toEqual(['lsp']);
    expect(manager.contributedServices()).toHaveLength(0);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('contributes session services and the lsp tool when the flag is on', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag((id) => id === LSP_FLAG_ID)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    const services = manager
      .contributedServices()
      .filter((entry) => entry.scope === LifecycleScope.Session)
      .map((entry) => entry.id);
    expect(services).toEqual([ILspService, ILspStdioProviderService]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const tools = collectionViewOf(agent, AgentToolContribution).items.map(
      (record) => record.options.name,
    );
    expect(tools).toEqual(['lsp']);
    host.dispose();
  });
});
