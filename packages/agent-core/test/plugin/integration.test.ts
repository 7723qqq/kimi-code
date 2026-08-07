import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

async function makeKimiHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-int-'));
  return realpath(home);
}

async function makePlugin(
  name: string,
  options: { skills?: boolean; skillNames?: readonly string[] } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-int-${name}-`));
  const manifest: Record<string, unknown> = { name };
  const skillNames = options.skillNames ?? (options.skills === true ? ['demo-skill'] : []);
  if (skillNames.length > 0) {
    manifest['skills'] = './skills/';
    await mkdir(path.join(root, 'skills'), { recursive: true });
    for (const skillName of skillNames) {
      await mkdir(path.join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        path.join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A demo\n---\nbody`,
        'utf8',
      );
    }
  }
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  return realpath(root);
}

describe('PluginManager → SkillRegistry integration', () => {
  it('enabled plugin contributes to pluginSkillRoots()', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-')));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills/' }),
      'utf8',
    );
    await mkdir(path.join(pluginRoot, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'demo'));

    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedRoot, 'skills'),
      source: 'extra',
      plugin: { id: 'demo', instructions: undefined },
    });
  });

  it('plugin with no skills contributes empty pluginSkillRoots', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('no-skills');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('plugin in error state contributes empty pluginSkillRoots', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('broken');
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      '{ not json',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('removing a plugin clears its skill roots', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('removable', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    expect(manager.pluginSkillRoots()).toHaveLength(1);
    await manager.remove('removable');
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('two plugins each contribute their own skill roots', async () => {
    const home = await makeKimiHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skillNames: ['skill-x', 'skill-y'] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    expect(manager.pluginSkillRoots()).toHaveLength(2);
  });
});

describe('plugin system-prompt integration', () => {
  it('flows enabledSystemPrompts() into the session prompt and refreshes on the reload push', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-')));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', systemPrompt: 'Always cite sources.' }),
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);

    const workDir = await mkdtemp(path.join(tmpdir(), 'plugin-work-'));
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'plugin-session-'));
    const session = new Session({
      id: 'test-plugin-system-prompts',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: sessionRpcStub(),
      skills: { explicitDirs: [path.join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
      pluginSystemPrompts: manager.enabledSystemPrompts(),
    });
    const profile: ResolvedAgentProfile = {
      name: 'plugin-profile',
      systemPrompt: (context) => context.pluginSections ?? '',
      tools: [],
    };
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: createScriptedGenerate().generate },
      { profile },
    );
    expect(mainAgent.config.systemPrompt).toBe(
      '<!-- From: plugin demo -->\nAlways cite sources.',
    );

    // The /plugins reload push: the core re-reads the consumption plane after
    // a reload and every live session re-renders its prompt.
    await writeFile(
      path.join(home, 'plugins', 'managed', 'demo', 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', systemPrompt: 'Cite v2 sources.' }),
      'utf8',
    );
    await manager.reload();
    await session.setPluginSystemPrompts(manager.enabledSystemPrompts());

    expect(mainAgent.config.systemPrompt).toBe('<!-- From: plugin demo -->\nCite v2 sources.');
  });
});

function sessionRpcStub(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
  } as unknown as SDKSessionRPC;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: { type: 'kimi', apiKey: 'test-key' },
      },
      models: {
        'mock-model': {
          provider: 'test',
          model: 'mock-model',
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}
