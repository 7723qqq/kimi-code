import { describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseManifest } from '../../../src/app/plugin/manifest';
import { discoverFileSkills } from '../../../src/features/skill/catalog/fileSkillDiscovery';
import { qualifyMcpToolName } from '../../../src/mcpCore/tool-naming';

const repositoryRoot = resolve(import.meta.dir, '../../../../..');
const pluginRoot = join(repositoryRoot, 'plugins/official/rea');

describe('official REA plugin', () => {
  it('declares the managed Bun MCP server without implicit permission grants', async () => {
    const parsed = await parseManifest(pluginRoot);
    if (parsed.manifest === undefined) throw new Error('REA plugin manifest is missing');
    const server = parsed.manifest.mcpServers?.['rea'];
    expect(server).toMatchObject({
      command: 'node',
      args: ['./scripts/plugin-mcp-launcher.mjs', '6.9.0'],
      deferred: true,
      startupTimeoutMs: 30_000,
      toolTimeoutMs: 450_000,
      env: {
        REA_MCP_TOOL_CATALOG_PROFILE: 'full',
        REA_MCP_INPUT_SCHEMA_PROFILE: 'compact',
        REA_MCP_OUTPUT_SCHEMA_PROFILE: 'compact',
      },
    });
    expect(parsed.manifest.sessionStart).toBeUndefined();
    expect(parsed.manifest.skillInstructions).toContain('mcp__plugin-rea_rea__');
    expect(parsed.manifest.skillInstructions).toContain('select_tools');
    expect(parsed.manifest.skillInstructions).toContain('REA_MCP_TOOL_CATALOG_PROFILE=full');
    expect(parsed.manifest.skillInstructions).toContain('Do not run rea setup');
    const raw = JSON.parse(await readFile(join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
    expect(raw).not.toHaveProperty('permissions');
    expect(raw).not.toHaveProperty('permissionRules');
    expect(qualifyMcpToolName('plugin-rea:rea', 'open_binary')).toBe(
      'mcp__plugin-rea_rea__open_binary',
    );
  });

  it('ships one file skill and all eight references', async () => {
    const discovered = await discoverFileSkills([
      { path: join(pluginRoot, 'skills'), source: 'extra', plugin: { id: 'rea' } },
    ]);
    expect(discovered.skills.map((skill) => skill.name)).toEqual(['reverse-engineer-anything']);
    expect(discovered.skills[0]?.description).toContain('Reverse engineer');
    const references = (
      await readdir(join(pluginRoot, 'skills/reverse-engineer-anything/references'))
    )
      .filter((name) => name.endsWith('.md'))
      .toSorted();
    expect(references).toEqual([
      'android-applications.md',
      'connection-and-recovery.md',
      'desktop-build.md',
      'environments.md',
      'evidence-workflows.md',
      'javascript-applications.md',
      'native-and-artifacts.md',
      'runtime-observation.md',
    ]);
  });

  it('pins the marketplace entry to the committed runtime archive', async () => {
    const marketplace = JSON.parse(
      await readFile(join(repositoryRoot, 'plugins/marketplace.json'), 'utf8'),
    );
    const entry = marketplace.plugins.find(
      (candidate: { readonly id: string }) => candidate.id === 'rea',
    );
    expect(entry).toMatchObject({
      id: 'rea',
      tier: 'official',
      version: '6.9.0-kimi.1',
      sha256sum: '3f56bff0975aa4fe963fc6d1205e5a89fac4185a9e06d6e1d75397d62fe564b1',
      clients: ['cli'],
      platforms: ['windows'],
    });
    expect(entry.source).toBe(
      'https://github.com/7723qqq/rea/releases/download/6.9.0-kimi.1/rea-kimi-plugin-6.9.0-kimi.1-win32-x64.zip',
    );
  });
});
