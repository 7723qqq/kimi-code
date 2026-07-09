/**
 * `skillCatalog` domain (L3) — CLI-injected skill directory carrier.
 *
 * Holds the `--skills-dir` values passed by the host (CLI / SDK), seeded into
 * the App scope at bootstrap so the Session-scope `ExplicitSkillSource` can
 * resolve them relative to each session's `workDir`. Defaults to empty when
 * the host does not inject any. App-scoped token, pure data.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ICliSkillDirs {
  readonly _serviceBrand: undefined;
  readonly dirs: readonly string[];
}

export const ICliSkillDirs: ServiceIdentifier<ICliSkillDirs> =
  createDecorator<ICliSkillDirs>('cliSkillDirs');
