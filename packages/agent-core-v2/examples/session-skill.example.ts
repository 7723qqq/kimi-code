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
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (the filesystem `ISkillCatalogStore`, the workspace context, …) so the
 * catalog reads real `SKILL.md` files from disk. We seed an empty
 * `IPluginService` so the slice stays focused on the builtin / user / project
 * layers and contributes no plugin skills.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/session-skill.example.ts
 */

import { afterEach, describe, expect, test } from 'vitest';

import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';

import { createSliceHost, type SliceHost } from './_harness';

/** Plugin contribution plane turned off: no plugin skill roots, no reloads. */
const noopPlugins: IPluginService = {
  _serviceBrand: undefined,
  pluginSkillRoots: async () => [],
  onDidReload: () => ({ dispose: () => {} }),
} as unknown as IPluginService;

describe('session skill catalog (load from current dir + inspect provenance)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp() {
    if (process.env['KIMI_CODE_HOME'] === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    host = createSliceHost({
      homeDir: process.env['KIMI_CODE_HOME'],
      cwd: process.cwd(),
      sessionSeeds: [[IPluginService as ServiceIdentifier<unknown>, noopPlugins]],
    });
    return host.session.accessor.get(ISessionSkillCatalog);
  }

  test('lists every merged skill with its source and path', async () => {
    const catalog = setUp();
    await catalog.load();
    await catalog.ready;

    const skills = catalog.catalog.listSkills();
    console.log('total skills =', skills.length);

    const counts = new Map<string, number>();
    for (const skill of skills) {
      counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
      console.log(`  [${skill.source}] ${skill.name}`);
    }
    console.log('by source =', Object.fromEntries(counts));

    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(['builtin', 'user', 'extra', 'project']).toContain(skill.source);
    }
  });

  test('inspects a single skill by name and reports its provenance', async () => {
    const catalog = setUp();
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
    });
    expect(inspected.name).toBe(first.name);
    expect(inspected.source).toBe(first.source);
  });
});
