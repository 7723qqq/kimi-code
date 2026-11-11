import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import {
  toolDefinitionVersionSignature,
  type ExecutableTool,
  type ToolExecution,
} from '#/tool/toolContract';

class StubTool implements ExecutableTool<unknown> {
  readonly parameters = { type: 'object', additionalProperties: true };

  constructor(
    readonly name: string,
    readonly description: string = 'stub tool',
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({ output: `${this.name} result` }),
    };
  }
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let registry: IAgentToolRegistryService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
    },
    strict: true,
  });
  registry = ix.get(IAgentToolRegistryService);
});

afterEach(() => {
  disposables.dispose();
});

describe('AgentToolRegistryService', () => {
  it('resolves a registered tool by name', () => {
    const tool = new StubTool('Bash');
    registry.register(tool);

    const resolved = registry.resolve('Bash');
    expect(resolved).toBe(tool);
  });

  it('returns undefined for unknown tool names', () => {
    expect(registry.resolve('NonExistent')).toBeUndefined();
  });

  it('lists registered tools sorted by name', () => {
    registry.register(new StubTool('Zebra'));
    registry.register(new StubTool('Apple'));
    registry.register(new StubTool('Mango'));

    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('includes source metadata in the listing', () => {
    const builtin = new StubTool('Builtin');
    const user = new StubTool('User');
    const mcp = new StubTool('Mcp');

    registry.register(builtin, { source: 'builtin' });
    registry.register(user, { source: 'user' });
    registry.register(mcp, { source: 'mcp' });

    const list = registry.list();
    expect(list.find((t) => t.name === 'Builtin')?.source).toBe('builtin');
    expect(list.find((t) => t.name === 'User')?.source).toBe('user');
    expect(list.find((t) => t.name === 'Mcp')?.source).toBe('mcp');
  });

  it('defaults to "builtin" source when none specified', () => {
    registry.register(new StubTool('Default'));
    const list = registry.list();
    expect(list.find((t) => t.name === 'Default')?.source).toBe('builtin');
  });

  it('unregisters a tool when the IDisposable is disposed', () => {
    const tool = new StubTool('Temp');
    const handle = registry.register(tool);

    expect(registry.resolve('Temp')).toBe(tool);

    handle.dispose();
    expect(registry.resolve('Temp')).toBeUndefined();
  });

  it('replaces an existing tool when re-registering the same name with an unchanged definition', () => {
    const original = new StubTool('Echo', 'stable');
    const replacement = new StubTool('Echo', 'stable');

    registry.register(original);
    expect(registry.resolve('Echo')).toBe(original);

    registry.register(replacement);
    expect(registry.resolve('Echo')).toBe(replacement);
  });

  it('keeps the active schema and executor when a same-name definition changes', () => {
    const original = new StubTool('Echo', 'original');
    const changed = new StubTool('Echo', 'changed');

    registry.register(original);
    const handle = registry.register(changed);

    expect(handle.status).toBe('pending');
    expect(registry.resolve('Echo')).toBe(original);
    expect(registry.list()).toEqual([
      expect.objectContaining({ name: 'Echo', description: 'original' }),
    ]);
    expect(registry.listLive?.()).toEqual([
      expect.objectContaining({ name: 'Echo', description: 'changed' }),
    ]);

    handle.dispose();
    expect(registry.listLive?.()).toEqual([
      expect.objectContaining({ name: 'Echo', description: 'original' }),
    ]);
    expect(registry.resolve('Echo')).toBe(original);
  });

  it('reports active status when a same-name definition is unchanged', () => {
    const original = new StubTool('Echo', 'stable');
    const replacement = new StubTool('Echo', 'stable');

    registry.register(original);
    const handle = registry.register(replacement);

    expect(handle.status).toBe('active');
    expect(registry.resolve('Echo')).toBe(replacement);
    expect(registry.listLive?.()).toEqual(registry.list());
  });

  it('does not unregister a replacement when the original disposable fires', () => {
    const original = new StubTool('Echo', 'stable');
    const replacement = new StubTool('Echo', 'stable');

    const originalHandle = registry.register(original);
    registry.register(replacement);

    originalHandle.dispose();
    expect(registry.resolve('Echo')).toBe(replacement);
  });

  it('lists tool info with description and parameters', () => {
    const tool = new StubTool('Search', 'Search files');
    registry.register(tool);

    const info = registry.list().find((t) => t.name === 'Search');
    expect(info).toBeDefined();
    expect(info?.description).toBe('Search files');
    expect(info?.parameters).toEqual({ type: 'object', additionalProperties: true });
  });

  it('registering a tool with an empty name does not crash', () => {
    expect(() => {
      registry.register(new StubTool(''));
    }).not.toThrow();
  });

  it('disposing a registration handle twice is safe', () => {
    const tool = new StubTool('DoubleDispose');
    const handle = registry.register(tool);
    handle.dispose();
    handle.dispose();
    expect(registry.resolve('DoubleDispose')).toBeUndefined();
  });

  it('registering the same tool instance twice does not throw', () => {
    const tool = new StubTool('Dupe');
    registry.register(tool);
    expect(() => {
      registry.register(tool);
    }).not.toThrow();
  });

  it('list returns an empty array when no tools are registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('calling unregister on a disposable handle from a replaced registration is safe', () => {
    const original = new StubTool('A', 'stable');
    const replacement = new StubTool('A', 'stable');

    const originalHandle = registry.register(original);
    const replacementHandle = registry.register(replacement);

    originalHandle.dispose();
    expect(registry.resolve('A')).toBe(replacement);

    replacementHandle.dispose();
    expect(registry.resolve('A')).toBeUndefined();
  });

  it('bumps its revision on register, replacement and pending changes', () => {
    const initial = registry.revision;
    registry.register(new StubTool('Echo', 'stable'));
    const afterRegister = registry.revision;
    expect(afterRegister).toBeGreaterThan(initial);

    registry.register(new StubTool('Echo', 'stable'));
    const afterReplacement = registry.revision;
    expect(afterReplacement).toBeGreaterThan(afterRegister);

    const pending = registry.register(new StubTool('Echo', 'changed'));
    expect(pending.status).toBe('pending');
    const afterPending = registry.revision;
    expect(afterPending).toBeGreaterThan(afterReplacement);

    pending.dispose();
    expect(registry.revision).toBeGreaterThan(afterPending);
  });

  it('bumps its revision when an active tool is unregistered', () => {
    const handle = registry.register(new StubTool('Temp'));
    const before = registry.revision;

    handle.dispose();

    expect(registry.revision).toBeGreaterThan(before);
    expect(registry.resolve('Temp')).toBeUndefined();
  });

  it('keeps the version signature equal across equivalent tool info objects', () => {
    const tool = {
      name: 'Echo',
      description: 'Echoes',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      source: 'builtin' as const,
    };

    expect(toolDefinitionVersionSignature({ ...tool })).toBe(
      toolDefinitionVersionSignature({ ...tool }),
    );
    expect(toolDefinitionVersionSignature({ ...tool, source: 'mcp' })).not.toBe(
      toolDefinitionVersionSignature({ ...tool }),
    );
    expect(toolDefinitionVersionSignature({ ...tool, disclosure: 'deferred' })).not.toBe(
      toolDefinitionVersionSignature({ ...tool }),
    );
  });
});
