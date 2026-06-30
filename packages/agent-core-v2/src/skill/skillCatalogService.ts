/**
 * `skill` domain (L5) — `ISessionSkillCatalog` implementation.
 *
 * Merges the global catalog (`IGlobalSkillCatalog`) with the project skills
 * discovered through `ISkillCatalogStore` for the session's current workDir
 * (`workspaceContext`). Project skills override global skills on name
 * collision. `ready` resolves once the first `load()` completes, so consumers
 * (e.g. skill activation) can await it instead of racing the asynchronous
 * discovery. Reloads when the workDir changes. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionWorkspaceContext } from '#/workspaceContext';

import { IGlobalSkillCatalog } from './globalSkillCatalog';
import { InMemorySkillCatalog } from './registry';
import { ISessionSkillCatalog } from './skillCatalog';
import { ISkillCatalogStore } from './skillCatalogStore';
import type { SkillCatalog } from './types';

export class SessionSkillCatalogService implements ISessionSkillCatalog {
  declare readonly _serviceBrand: undefined;

  private inner = new InMemorySkillCatalog();
  private loadedWorkDir: string | undefined;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(
    @IGlobalSkillCatalog private readonly global: IGlobalSkillCatalog,
    @ISkillCatalogStore private readonly store: ISkillCatalogStore,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  get catalog(): SkillCatalog {
    return this.inner;
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  async load(): Promise<void> {
    const workDir = this.workspace.workDir;
    if (this.loadedWorkDir === workDir) return;
    this.readyPromise = this.discover(workDir);
    await this.readyPromise;
  }

  private async discover(workDir: string): Promise<void> {
    await this.global.load();
    const { skills } = await this.store.discoverProject(workDir);
    const merged = new InMemorySkillCatalog();
    for (const skill of this.global.catalog.listSkills()) {
      merged.register(skill);
    }
    for (const skill of skills) {
      merged.register(skill, { replace: true });
    }
    this.inner = merged;
    this.loadedWorkDir = workDir;
  }

  async reload(): Promise<void> {
    this.loadedWorkDir = undefined;
    await this.load();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSkillCatalog,
  SessionSkillCatalogService,
  InstantiationType.Delayed,
  'skill',
);
