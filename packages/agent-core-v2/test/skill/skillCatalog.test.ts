import { describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';
import { ISessionWorkspaceContext } from '#/workspaceContext';
import '#/skill';
import { InMemorySkillCatalogStore } from '#/skill/inMemorySkillCatalogStore';
import { ISessionSkillCatalog } from '#/skill/skillCatalog';
import { ISkillCatalogStore } from '#/skill/skillCatalogStore';

import { stubSkill } from './stubs';

const bootstrapStub = {
  _serviceBrand: undefined,
  homeDir: '/home',
  osHomeDir: '/home',
} as unknown as IBootstrapService;

function workspaceStub(workDir: string): {
  readonly stub: ISessionWorkspaceContext;
  setWorkDir(dir: string): void;
} {
  let current = workDir;
  const stub = {
    _serviceBrand: undefined,
    get workDir() {
      return current;
    },
    additionalDirs: [] as readonly string[],
    setWorkDir: (dir: string) => {
      current = dir;
    },
    resolve: (rel: string) => rel,
    isWithin: () => true,
    assertAllowed: (p: string) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  } satisfies ISessionWorkspaceContext;
  return { stub, setWorkDir: (dir) => { current = dir; } };
}

function makeHost(store: InMemorySkillCatalogStore, ws: ISessionWorkspaceContext) {
  const host = createScopedTestHost([
    stubPair(ISkillCatalogStore, store),
    stubPair(IBootstrapService, bootstrapStub),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);
  return { host, session };
}

describe('SessionSkillCatalogService', () => {
  it('merges global and project skills; project wins on name collision', async () => {
    const store = new InMemorySkillCatalogStore();
    store.setUserSkills([
      stubSkill('global-only'),
      stubSkill('shared', { description: 'from user' }),
    ]);
    store.setProjectSkills([
      stubSkill('project-only'),
      stubSkill('shared', { description: 'from project' }),
    ]);
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    const names = catalog.catalog.listSkills().map((s) => s.name);
    expect(names).toContain('global-only');
    expect(names).toContain('project-only');
    expect(names).toContain('shared');
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    host.dispose();
  });

  it('reload replaces project skills when the workDir changes', async () => {
    const store = new InMemorySkillCatalogStore();
    store.setUserSkills([stubSkill('global-only')]);
    store.setProjectSkills([stubSkill('first')]);
    const { stub: ws, setWorkDir } = workspaceStub('/work1');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();
    expect(catalog.catalog.getSkill('first')).toBeDefined();

    setWorkDir('/work2');
    store.setProjectSkills([stubSkill('second')]);
    await catalog.reload();

    expect(catalog.catalog.getSkill('first')).toBeUndefined();
    expect(catalog.catalog.getSkill('second')).toBeDefined();
    expect(catalog.catalog.getSkill('global-only')).toBeDefined();
    host.dispose();
  });

  it('does not reload when the workDir is unchanged', async () => {
    const store = new InMemorySkillCatalogStore();
    store.setProjectSkills([stubSkill('first')]);
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    store.setProjectSkills([stubSkill('second')]);
    await catalog.load();

    expect(catalog.catalog.getSkill('first')).toBeDefined();
    expect(catalog.catalog.getSkill('second')).toBeUndefined();
    host.dispose();
  });
});
