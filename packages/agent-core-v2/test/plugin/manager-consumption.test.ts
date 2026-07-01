import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

async function managedPluginRoot(home: string, id: string): Promise<string> {
  return realpath(path.join(home, 'plugins', 'managed', id));
}

async function makePlugin(
  name: string,
  options: {
    skills?: boolean;
    skillNames?: readonly string[];
    version?: string;
    sessionStartSkill?: string;
    mcpServers?: Record<string, unknown>;
    hooks?: readonly unknown[];
    commands?: Record<string, string>;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  const manifest: Record<string, unknown> = { name };
  if (options.version !== undefined) {
    manifest['version'] = options.version;
  }
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
  if (options.sessionStartSkill !== undefined) {
    manifest['sessionStart'] = { skill: options.sessionStartSkill };
  }
  if (options.mcpServers !== undefined) {
    manifest['mcpServers'] = options.mcpServers;
  }
  if (options.hooks !== undefined) {
    manifest['hooks'] = options.hooks;
  }
  if (options.commands !== undefined) {
    manifest['commands'] = ['./commands'];
    await mkdir(path.join(root, 'commands'), { recursive: true });
    for (const [file, body] of Object.entries(options.commands)) {
      const filePath = path.join(root, 'commands', file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, body, 'utf8');
    }
  }
  await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(manifest), 'utf8');
  return realpath(root);
}

async function zipDir(sourceRoot: string): Promise<Buffer> {
  const zipPath = path.join(tmpdir(), `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
  const buffer = await readFile(zipPath);
  await rm(zipPath, { force: true });
  return buffer;
}

async function serveOnce(buffer: Buffer): Promise<string> {
  const server = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(buffer);
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('bad server address');
  return `http://127.0.0.1:${address.port}/plugin.zip`;
}

interface MockGithubFetchOptions {
  releaseTag?: string;
  tarball: Buffer;
  onReleaseLookup?: () => void;
}

function mockGithubFetch(options: MockGithubFetchOptions): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
        options.onReleaseLookup?.();
        if (options.releaseTag === undefined) {
          return new Response(null, { status: 404 });
        }
        const tagUrl = url.replace(/\/releases\/latest$/, `/releases/tag/${options.releaseTag}`);
        return new Response(null, { status: 302, headers: { location: tagUrl } });
      }
      if (url.startsWith('https://codeload.github.com/')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 200 });
        return new Response(options.tarball, { status: 200 });
      }
      throw new Error(`mockGithubFetch: unexpected url ${url}`);
    }) as typeof fetch,
  );
}

describe('PluginManager consumption plane', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pluginSkillRoots() returns only enabled plugins skills paths', async () => {
    const home = await makeKimiHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const managedA = await managedPluginRoot(home, 'a');
    const managedB = await managedPluginRoot(home, 'b');
    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedA, 'skills'),
      source: 'extra',
      plugin: { id: 'a', instructions: undefined },
    });
    expect(manager.pluginSkillRoots()).not.toContainEqual({
      path: path.join(managedB, 'skills'),
      source: 'extra',
      plugin: { id: 'b', instructions: undefined },
    });
  });

  it('pluginSkillRoots() excludes plugins in error state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await writeFile(
      path.join(await managedPluginRoot(home, 'demo'), 'kimi.plugin.json'),
      '{ not json',
      'utf8',
    );
    await manager.reload();
    expect(manager.get('demo')?.state).toBe('error');
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('summaries count discovered skills inside plugin skill roots', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('superpowers', {
      skillNames: ['brainstorming', 'systematic-debugging', 'writing-plans'],
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.summaries()).toContainEqual(
      expect.objectContaining({ id: 'superpowers', skillCount: 3 }),
    );
    expect(manager.info('superpowers')?.skillCount).toBe(3);
  });

  it('enabledSessionStarts() returns only enabled plugin sessionStart declarations', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true, sessionStartSkill: 'demo-skill' });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.enabledSessionStarts()).toEqual([{ pluginId: 'demo', skillName: 'demo-skill' }]);
    await manager.setEnabled('demo', false);
    expect(manager.enabledSessionStarts()).toEqual([]);
  });

  it('setMcpServerEnabled() persists explicit MCP server state with cwd + env + runtime name', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: {
        finance: { command: 'finance-mcp' },
        docs: { url: 'https://example.com/mcp' },
        events: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(home, 'demo');

    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'finance',
        runtimeName: 'plugin-demo:finance',
        enabled: true,
        command: 'finance-mcp',
      }),
    );
    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'events',
        runtimeName: 'plugin-demo:events',
        transport: 'sse',
        url: 'https://example.com/sse',
      }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 3, enabledMcpServerCount: 3 }),
    );

    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({
          command: 'finance-mcp',
          cwd: managedRoot,
          env: expect.objectContaining({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: managedRoot }),
        }),
        'plugin-demo:docs': expect.objectContaining({ url: 'https://example.com/mcp' }),
        'plugin-demo:events': expect.objectContaining({
          transport: 'sse',
          url: 'https://example.com/sse',
        }),
      }),
    );

    await manager.setMcpServerEnabled('demo', 'finance', false);
    expect(manager.enabledMcpServers()).not.toHaveProperty('plugin-demo:finance');
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 3, enabledMcpServerCount: 2 }),
    );

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
  });

  it('merges manifest MCP enabled defaults with explicit user state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: { finance: { command: 'finance-mcp', enabled: false } },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 1, enabledMcpServerCount: 0 }),
    );
    expect(manager.enabledMcpServers()).toEqual({});

    await manager.setMcpServerEnabled('demo', 'finance', true);
    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({ command: 'finance-mcp', enabled: true }),
      }),
    );

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: true }),
    );
    expect(reloaded.enabledMcpServers()).toHaveProperty('plugin-demo:finance');
  });

  it('uses unambiguous runtime names for plugin MCP servers', async () => {
    const home = await makeKimiHome();
    const first = await makePlugin('a-b', { mcpServers: { c: { command: 'first-mcp' } } });
    const second = await makePlugin('a', { mcpServers: { 'b-c': { command: 'second-mcp' } } });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(first);
    await manager.install(second);
    expect(manager.info('a-b')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'c', runtimeName: 'plugin-a-b:c' }),
    );
    expect(manager.info('a')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'b-c', runtimeName: 'plugin-a:b-c' }),
    );
    const servers = manager.enabledMcpServers();
    expect(servers).toEqual(
      expect.objectContaining({
        'plugin-a-b:c': expect.objectContaining({ command: 'first-mcp' }),
        'plugin-a:b-c': expect.objectContaining({ command: 'second-mcp' }),
      }),
    );
    expect(Object.keys(servers)).toHaveLength(2);
  });

  it('enabledMcpServers() excludes disabled plugins', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { mcpServers: { finance: { command: 'finance-mcp' } } });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setMcpServerEnabled('demo', 'finance', true);
    await manager.setEnabled('demo', false);
    expect(manager.enabledMcpServers()).toEqual({});
  });

  it('setMcpServerEnabled() rejects unknown MCP servers', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await expect(manager.setMcpServerEnabled('demo', 'missing', true)).rejects.toThrow(
      /does not declare MCP server/i,
    );
  });

  it('reload() picks up edits to the managed plugin copy', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(home, 'demo');
    await writeFile(
      path.join(managedRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'utf8',
    );
    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBe('2.0.0');
  });

  it('remove() clears the entry but does not delete the source directory', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.remove('demo');
    expect(manager.get('demo')).toBeUndefined();
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('enabledHooks() returns hooks from enabled plugins with cwd and env injected', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      hooks: [{ event: 'PreToolUse', command: './hooks/guard.sh', timeout: 10 }],
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const installedRoot = await managedPluginRoot(home, 'demo');
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'PreToolUse',
        command: './hooks/guard.sh',
        timeout: 10,
        cwd: installedRoot,
        env: { KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: installedRoot },
      },
    ]);
  });

  it('enabledHooks() excludes disabled plugins', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { hooks: [{ event: 'PreToolUse', command: './x.sh' }] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setEnabled('demo', false);
    expect(manager.enabledHooks()).toEqual([]);
  });

  it('install() from /tree/<tag-shaped-ref> downloads via short form, not refs/heads/', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-tag-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);

    let codeloadPath = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://codeload.github.com/')) {
          codeloadPath = new URL(url).pathname;
          return new Response(zipBuffer, { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    );

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/obra/superpowers/tree/v5.1.0');
    expect(codeloadPath).toBe('/obra/superpowers/zip/v5.1.0');
    expect(record.github?.ref).toEqual({ kind: 'branch', value: 'v5.1.0' });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() from /releases/tag/<tag> resolves precisely via refs/tags/', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-release-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);

    let codeloadPath = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://codeload.github.com/')) {
          codeloadPath = new URL(url).pathname;
          return new Response(zipBuffer, { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    );

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/obra/superpowers/releases/tag/v5.1.0');
    expect(codeloadPath).toBe('/obra/superpowers/zip/refs/tags/v5.1.0');
    expect(record.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() from github /tree/<branch> bypasses the GitHub API', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-branch-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'gh-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);

    let releaseLookups = 0;
    mockGithubFetch({ tarball: zipBuffer, onReleaseLookup: () => releaseLookups++ });

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/wbxl2000/superpowers/tree/main');
    expect(releaseLookups).toBe(0);
    expect(record.source).toBe('github');
    expect(record.github?.ref).toEqual({ kind: 'branch', value: 'main' });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() ignores forged marketplace context from legacy callers', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('rando', { version: '1.0.0' });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await (manager.install as (source: string, options?: unknown) => Promise<unknown>)(
      root,
      { marketplace: { id: 'rando', tier: 'official' } },
    );
    expect((record as { marketplace?: unknown }).marketplace).toBeUndefined();
  });

  it('install() from github URL overwrites an existing zip-url install (CDN migration)', async () => {
    const home = await makeKimiHome();

    const cdnSource = await mkdtemp(path.join(tmpdir(), 'plugin-cdn-'));
    await writeFile(
      path.join(cdnSource, 'kimi.plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '5.0.0' }),
      'utf8',
    );
    const cdnUrl = await serveOnce(await zipDir(cdnSource));

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const first = await manager.install(cdnUrl);
    expect(first.source).toBe('zip-url');
    await manager.setEnabled('superpowers', false);

    const ghSource = await mkdtemp(path.join(tmpdir(), 'plugin-gh-migrate-'));
    await writeFile(
      path.join(ghSource, 'kimi.plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '5.1.0' }),
      'utf8',
    );
    mockGithubFetch({ releaseTag: 'v5.1.0', tarball: await zipDir(ghSource) });

    const updated = await manager.install('https://github.com/wbxl2000/superpowers');
    expect(updated.source).toBe('github');
    expect(updated.manifest?.version).toBe('5.1.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe(first.installedAt);
    expect(updated.originalSource).toBe('https://github.com/wbxl2000/superpowers');
    expect(updated.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(manager.list()).toHaveLength(1);

    await rm(cdnSource, { recursive: true, force: true });
    await rm(ghSource, { recursive: true, force: true });
  });
});
