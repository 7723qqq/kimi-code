/**
 * `skill` domain (L5) — session skill catalog contract.
 *
 * `ISkillCatalog` holds the active skill set for one session: the global
 * catalog (builtin + user/brand) merged with the project skills discovered
 * from the session's current `workDir`. It reloads when the workDir changes.
 * Session-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { SkillCatalog } from './types';

export interface ISkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;

  readonly ready: Promise<void>;

  load(): Promise<void>;

  reload(): Promise<void>;
}

export const ISkillCatalog = createDecorator<ISkillCatalog>('skillCatalog');
