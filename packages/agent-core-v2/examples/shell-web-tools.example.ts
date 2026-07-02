/**
 * Scenario: the **shell / web / ask tools** slice — built-in tool
 * implementations discovered through the module-level contribution registry
 * and executed through the kaos execution boundary.
 *
 * Concept taught: the tools an agent can run are not hard-coded into the agent.
 * Each built-in tool is a DI class that self-registers via `registerTool(...)`
 * at module load. When an Agent scope is created, `IAgentToolRegistryService`'s
 * constructor consumes every module-level contribution — instantiating each
 * tool with `IInstantiationService.createInstance` and dropping the resulting
 * `ExecutableTool` into the per-agent runtime table:
 *   - `BashTool`             → `Bash`
 *   - `FetchURLTool`         → `FetchURL` (and `WebSearchTool` → `WebSearch`
 *                              when the host supplies a `WebSearchProvider`
 *                              via the `web` service options)
 *   - `AskUserQuestionTool`  → `AskUserQuestion`
 * Once registered, a tool is discovered through `list()` / `resolve(name)` and
 * run through the same `resolveExecution → execute(ctx)` path every tool uses.
 * `Bash` executes through the kaos `ISessionProcessRunner` (a real shell
 * process in the session cwd) — never `node:child_process` directly.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (the seeded `IExecContext`, the real `ISessionProcessRunner`,
 * `IAgentBackgroundService`, `IHostEnvironment`, …) so the tools register and
 * run for real with no hand-rolled stub list. `WebSearch` is host-injected: it
 * only lands in the registry when a `WebSearchProvider` is supplied, so we
 * demonstrate that path by registering a `WebSearchTool` backed by a canned
 * provider (no network) through the registry's public `register` API.
 *
 * Prerequisites: the container & scope-tree example and the tool-framework example.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/shell-web-tools.example.ts
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  IAgentBuiltinToolsRegistrar,
  IAgentToolRegistryService,
} from '#/agent/toolRegistry';
import { IAgentWebService } from '#/agent/web';
import {
  WebSearchTool,
  type WebSearchProvider,
  type WebSearchResult,
} from '#/agent/web/tools/web-search';
import { IHostEnvironment } from '#/app/hostEnvironment';

import { createSliceHost, type SliceHost } from './_harness';

/** Read the JSON-schema `properties` bag off a tool's `parameters`. */
function schemaProps(tool: { parameters?: Record<string, unknown> }): Record<string, unknown> {
  const params = tool.parameters as { properties?: Record<string, unknown> } | undefined;
  return params?.properties ?? {};
}

describe('shell-web-tools slice (built-in tools via Agent-scope registration services)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  async function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    // `BashTool` reads `IHostEnvironment.osKind` in its constructor; the host
    // environment probes the OS asynchronously, so await its `ready` gate
    // before the tool is constructed (the real composition root awaits this
    // before opening a Session scope).
    await host.app.accessor.get(IHostEnvironment).ready;
    // Force-instantiate the Eager builtin-tools registrar: its constructor
    // consumes every module-level `registerTool(...)` contribution and builds
    // each tool instance against this Agent scope (the same path
    // `AgentLifecycleService.create` runs in production). Bash / AskUser land
    // this way; `FetchURL` is registered by `IAgentWebService` (options-based
    // service), so resolve that too.
    host.agent.accessor.get(IAgentBuiltinToolsRegistrar);
    host.agent.accessor.get(IAgentWebService);
    return host.agent.accessor.get(IAgentToolRegistryService);
  }

  it('registers the built-in Bash, FetchURL and AskUserQuestion tools with builtin metadata', async () => {
    const registry = await setUp();

    const byName = new Map(registry.list().map((t) => [t.name, t]));

    expect(byName.has('Bash')).toBe(true);
    expect(byName.has('FetchURL')).toBe(true);
    expect(byName.has('AskUserQuestion')).toBe(true);

    for (const name of ['Bash', 'FetchURL', 'AskUserQuestion']) {
      const info = byName.get(name)!;
      expect(info.source).toBe('builtin');
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.parameters).toBeDefined();
    }

    // `WebSearch` is host-injected: the real web service registers it only when
    // a `WebSearchProvider` is supplied, which the default composition root does
    // not. The next test demonstrates that path explicitly.
    expect(byName.has('WebSearch')).toBe(false);
  });

  it('resolves each built-in tool by name and exposes its input schema', async () => {
    const registry = await setUp();

    const bash = registry.resolve('Bash');
    const fetch = registry.resolve('FetchURL');
    const ask = registry.resolve('AskUserQuestion');

    expect(bash).toBeDefined();
    expect(fetch).toBeDefined();
    expect(ask).toBeDefined();
    expect(registry.resolve('DoesNotExist')).toBeUndefined();

    expect(schemaProps(bash!)).toHaveProperty('command');
    expect(schemaProps(fetch!)).toHaveProperty('url');
    expect(schemaProps(ask!)).toHaveProperty('questions');
  });

  it('invokes the Bash tool through the real process runner on a harmless command', async () => {
    const registry = await setUp();

    const bash = registry.resolve('Bash');
    expect(bash).toBeDefined();
    if (bash === undefined) return;

    const execution = await bash.resolveExecution({ command: 'echo hello' });
    expect('execute' in execution).toBe(true);
    if (!('execute' in execution)) return;

    const result = await execution.execute({
      turnId: 't1',
      toolCallId: 'call-bash',
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    expect(String(result.output)).toContain('hello');
  });

  it('registers a host-injected WebSearch tool and invokes it without network', async () => {
    const registry = await setUp();

    // Not present until a provider-backed tool is registered.
    expect(registry.resolve('WebSearch')).toBeUndefined();

    const canned: WebSearchResult[] = [
      { title: 'Example Result', url: 'https://example.com/', snippet: 'a canned snippet' },
    ];
    const provider: WebSearchProvider = {
      async search(_query, options) {
        return options?.includeContent ? canned.map((r) => ({ ...r, content: 'body' })) : canned;
      },
    };

    // Mirror what the real web service does when a provider is supplied.
    const registration = registry.register(new WebSearchTool(provider));

    const search = registry.resolve('WebSearch');
    expect(search).toBeDefined();
    if (search === undefined) return;

    const execution = await search.resolveExecution({ query: 'kimi code', limit: 5 });
    expect('execute' in execution).toBe(true);
    if (!('execute' in execution)) return;

    const result = await execution.execute({
      turnId: 't1',
      toolCallId: 'call-search',
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    expect(String(result.output)).toContain('Example Result');
    expect(String(result.output)).toContain('https://example.com/');

    // Disposing the registration handle unregisters the tool again.
    registration.dispose();
    expect(registry.resolve('WebSearch')).toBeUndefined();
  });
});
