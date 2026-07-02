/**
 * Scenario: the **session skill catalog** — loading the skills available in
 * the current directory and inspecting where each one came from.
 *
 * Concept taught: the skill domain is split across scopes by state identity.
 * `IGlobalSkillCatalog` (App) holds the process-wide set — code-defined
 * builtins plus user / brand skills discovered from the home directories — and
 * is loaded once; `ISessionSkillCatalog` (Session) merges that global set with
 * the project skills discovered from the session's current `workDir`
 * (`ISessionWorkspaceContext` ← `IExecContext.cwd`), reloading when the
 * workDir changes. Every `SkillDefinition` carries a `source` tag
 * (`builtin` | `user` | `extra` | `project`), so the catalog can report
 * *provenance* — which layer and which directory a skill came from — not just
 * its name.
 *
 * This example boots the production `startUpFileSystem` composition root so the
 * catalog reads real `SKILL.md` files from disk through the filesystem
 * `ISkillCatalogStore`, opens one Session scope rooted at `process.cwd()`, and
 * prints every merged skill together with its `source` and path.
 * `IPluginService` is seeded as an empty stub so the slice stays focused on the
 * builtin / user / project layers and contributes no plugin skills.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/session-skill.example.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, type Scope } from '#/_base/di/scope';
import { startUpFileSystem } from '#/app/bootstrap';
import '#/app/globalSkillCatalog';
import { IPluginService } from '#/app/plugin/plugin';
import { createExecContext, execContextSeed } from '#/session/execContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import '#/session/workspaceContext';

/** Plugin contribution plane turned off: no plugin skill roots, no reloads. */
const noopPlugins: IPluginService = {
  _serviceBrand: undefined,
  pluginSkillRoots: async () => [],
  onDidReload: () => ({ dispose: () => {} }),
} as unknown as IPluginService;

describe('session skill catalog (load from current dir + inspect provenance)', () => {
  let app: Scope;
  const workDir = process.cwd();

  beforeEach(() => {
    if (process.env['KIMI_CODE_HOME'] === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    app = startUpFileSystem({}).app;
  });
  afterEach(() => {
    app.dispose();
  });

  test('lists every merged skill with its source and path', async () => {
    const session = app.createChild(LifecycleScope.Session, 'skill-demo', {
      extra: [
        ...execContextSeed(createExecContext(workDir)),
        [IPluginService as ServiceIdentifier<unknown>, noopPlugins],
      ],
    });

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();
    await catalog.ready;

    const skills = catalog.catalog.listSkills();
    console.log('workDir =', workDir);
    console.log('total skills =', skills.length);

    const counts = new Map<string, number>();
    for (const skill of skills) {
      counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
      const via = skill.plugin !== undefined ? ` via plugin:${skill.plugin.id}` : '';
      console.log(`  [${skill.source}] ${skill.name}${via}`);
      console.log(`      ${skill.path}`);
    }
    console.log('by source =', Object.fromEntries(counts));

    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(['builtin', 'user', 'extra', 'project']).toContain(skill.source);
    }
  });

  test('inspects a single skill by name and reports its provenance', async () => {
    const session = app.createChild(LifecycleScope.Session, 'skill-inspect', {
      extra: [
        ...execContextSeed(createExecContext(workDir)),
        [IPluginService as ServiceIdentifier<unknown>, noopPlugins],
      ],
    });

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    const first = catalog.catalog.listSkills()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const inspected = catalog.catalog.getSkill(first.name);
    expect(inspected).toBeDefined();
    if (inspected === undefined) return;

    console.log('inspect:', {
      name: inspected.name,
      source: inspected.source,
      dir: inspected.dir,
      plugin: inspected.plugin?.id,
    });
    expect(inspected.name).toBe(first.name);
    expect(inspected.source).toBe(first.source);
  });
});
