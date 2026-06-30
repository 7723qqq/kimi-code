/**
 * `skill` domain (L5) — in-memory `ISkillCatalogStore` backend.
 *
 * Returns preset skill lists for project / user discovery without any IO.
 * Registered as the App-scope default so tests and scopes work without a
 * filesystem; the production composition root overrides it with the filesystem
 * backend. App-scoped.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { SkillDiscoveryResult } from './skillCatalogStore';
import { ISkillCatalogStore } from './skillCatalogStore';
import type { SkillDefinition } from './types';

export class InMemorySkillCatalogStore implements ISkillCatalogStore {
  declare readonly _serviceBrand: undefined;

  private projectSkills: readonly SkillDefinition[] = [];
  private userSkills: readonly SkillDefinition[] = [];

  setProjectSkills(skills: readonly SkillDefinition[]): void {
    this.projectSkills = [...skills];
  }

  setUserSkills(skills: readonly SkillDefinition[]): void {
    this.userSkills = [...skills];
  }

  async discoverProject(): Promise<SkillDiscoveryResult> {
    return { skills: this.projectSkills, skipped: [], scannedRoots: [] };
  }

  async discoverUser(): Promise<SkillDiscoveryResult> {
    return { skills: this.userSkills, skipped: [], scannedRoots: [] };
  }
}

registerScopedService(
  LifecycleScope.App,
  ISkillCatalogStore,
  InMemorySkillCatalogStore,
  InstantiationType.Delayed,
  'skill',
);
