/**
 * Scenario: the **extensions** slice — the plugin, MCP, and skill-catalog
 * surfaces through which the agent is extended without touching its core.
 *
 * Concept taught: three scoped services form the extension plane, each owning
 * a different lifetime and contribution channel.
 *
 *   - `IPluginService` (App) discovers installed plugins and exposes their
 *     *consumption plane*: skill roots, MCP servers, hooks, and session-start
 *     reminders that other domains fold in. With no plugins installed, every
 *     collection is empty — but the surface still resolves and reports shape.
 *   - `IAgentMcpService` (Agent) manages the per-agent MCP server connections:
 *     it lists configured servers, surfaces their status, and lets callers
 *     subscribe to `onStatusChange`. With no connection manager seeded, it
 *     resolves as a quiet shell — no servers, no network, an already-settled
 *     initial load.
 *   - `IGlobalSkillCatalog` (App) merges the code-defined builtin skills with
 *     user / brand skills discovered from the home directories, loading once
 *     and sharing the result with every Session catalog. Each `SkillDefinition`
 *     carries a `source` tag so the catalog reports provenance, not just names.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (the file-backed plugin store, the agent's MCP service shell, the filesystem
 * `ISkillCatalogStore`, …) so each surface resolves for real with no
 * hand-rolled stub list. The isolated `KIMI_CODE_HOME` has no plugins
 * installed and no MCP servers configured, so every surface reports empty
 * contents and nothing connects over the network or loads a real plugin.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/extensions.example.ts
 */

import { afterEach, describe, expect, test } from 'vitest';

import { IAgentMcpService } from '#/agent/mcp';
import { IGlobalSkillCatalog } from '#/app/globalSkillCatalog';
import { IPluginService } from '#/app/plugin';

import { createSliceHost, type SliceHost } from './_harness';

describe('extensions slice (plugins × MCP × skill catalog)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp(): SliceHost {
    if (process.env['KIMI_CODE_HOME'] === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME'] });
    return host;
  }

  test('plugin service resolves and reports no contributed skills/MCP/hooks when no plugins are installed', async () => {
    const h = setUp();
    const plugins = h.app.accessor.get(IPluginService);

    const summaries = await plugins.listPlugins();
    const mcpServers = await plugins.enabledMcpServers();
    const skillRoots = await plugins.pluginSkillRoots();
    const hooks = await plugins.enabledHooks();
    const sessionStarts = await plugins.enabledSessionStarts();

    console.log('plugins:', {
      installed: summaries.length,
      mcpServers: Object.keys(mcpServers).length,
      skillRoots: skillRoots.length,
      hooks: hooks.length,
      sessionStarts: sessionStarts.length,
    });

    // The consumption plane is present but empty: no plugins are installed.
    expect(summaries).toEqual([]);
    expect(mcpServers).toEqual({});
    expect(skillRoots).toEqual([]);
    expect(hooks).toEqual([]);
    expect(sessionStarts).toEqual([]);

    // `onDidReload` is an Event — subscribing yields a disposable and, with no
    // reload triggered, the listener never fires.
    let reloads = 0;
    const sub = plugins.onDidReload(() => {
      reloads++;
    });
    expect(typeof sub.dispose).toBe('function');
    sub.dispose();
    expect(reloads).toBe(0);
  });

  test('agent MCP service resolves with no servers and exposes a status subscription', async () => {
    const h = setUp();
    const mcp = h.agent.accessor.get(IAgentMcpService);

    const entries = mcp.list();
    console.log('agent MCP servers:', entries.length);

    // No connection manager is seeded, so no servers are configured or connected.
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toEqual([]);
    expect(mcp.resolved('does-not-exist')).toBeUndefined();
    expect(mcp.getRemoteServerUrl('does-not-exist')).toBeUndefined();

    // The initial load is already settled — nothing ever connected.
    await expect(mcp.waitForInitialLoad()).resolves.toBeUndefined();
    expect(mcp.initialLoadDurationMs()).toBe(0);
    expect(mcp.oauthService).toBeUndefined();

    // `onStatusChange` yields a disposable; with no servers the listener is
    // never invoked.
    let statusChanges = 0;
    const sub = mcp.onStatusChange(() => {
      statusChanges++;
    });
    expect(typeof sub.dispose).toBe('function');
    sub.dispose();
    expect(statusChanges).toBe(0);
  });

  test('global skill catalog loads builtin skills with provenance', async () => {
    const h = setUp();
    const globalCatalog = h.app.accessor.get(IGlobalSkillCatalog);

    await globalCatalog.load();

    const skills = globalCatalog.catalog.listSkills();
    const builtins = skills.filter((skill) => skill.source === 'builtin');
    console.log('skills:', { total: skills.length, builtin: builtins.length });

    // The code-defined builtins are always present after load.
    expect(skills.length).toBeGreaterThan(0);
    expect(builtins.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(['builtin', 'user', 'extra', 'project']).toContain(skill.source);
      expect(skill.name.length).toBeGreaterThan(0);
    }

    // `getSkill` round-trips a builtin by name and preserves its provenance.
    const first = builtins[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const inspected = globalCatalog.catalog.getSkill(first.name);
    expect(inspected).toBeDefined();
    if (inspected === undefined) return;
    expect(inspected.name).toBe(first.name);
    expect(inspected.source).toBe('builtin');
  });

  test('global skill catalog derives its model listing from invocable skills', async () => {
    const h = setUp();
    const globalCatalog = h.app.accessor.get(IGlobalSkillCatalog);
    await globalCatalog.load();

    const all = globalCatalog.catalog.listSkills();
    const invocable = globalCatalog.catalog.listInvocableSkills();
    const listing = globalCatalog.catalog.getModelSkillListing();

    console.log('catalog:', {
      total: all.length,
      invocable: invocable.length,
      listingChars: listing.length,
    });

    // Invocable skills are a filtered subset of the full catalog.
    expect(invocable.length).toBeLessThanOrEqual(all.length);
    const allNames = all.map((skill) => skill.name);
    for (const skill of invocable) {
      expect(allNames).toContain(skill.name);
    }

    // The model-facing listing is derived from the catalog (never hand-rolled).
    expect(typeof listing).toBe('string');
  });
});
