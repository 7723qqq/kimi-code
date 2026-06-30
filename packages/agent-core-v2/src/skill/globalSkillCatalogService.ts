/**
 * `skill` domain (L5) — `IGlobalSkillCatalog` implementation.
 *
 * Registers the builtin skills and discovers user / brand skills through the
 * `ISkillCatalogStore`, using the user home directories from `bootstrap`. The
 * result is cached after the first `load()`. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';

import { registerBuiltinSkills } from './builtin';
import { IGlobalSkillCatalog } from './globalSkillCatalog';
import { InMemorySkillCatalog } from './registry';
import { ISkillCatalogStore } from './skillCatalogStore';
import type { SkillCatalog } from './types';

export class GlobalSkillCatalogService implements IGlobalSkillCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly inner = new InMemorySkillCatalog();
  private loaded = false;

  constructor(
    @ISkillCatalogStore private readonly store: ISkillCatalogStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  get catalog(): SkillCatalog {
    return this.inner;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    registerBuiltinSkills(this.inner);
    const { skills } = await this.store.discoverUser(
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
    );
    for (const skill of skills) {
      this.inner.register(skill);
    }
    this.loaded = true;
  }
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSkillCatalog,
  GlobalSkillCatalogService,
  InstantiationType.Delayed,
  'skill',
);
