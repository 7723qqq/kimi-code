import { describe, expect, it } from 'bun:test';

import type { IAssociativeMemoryService } from '#/features/associativeMemory/service';
import { MEMORY_GRAPH_TOOL_NAME, MemoryGraphTool } from '#/features/associativeMemory/tools/memoryGraphTool';
import type { ExecutableToolContext } from '#/tool/toolContract';

const CONTEXT: ExecutableToolContext = {
  turnId: 1,
  toolCallId: 'call-1',
  signal: new AbortController().signal,
};

interface Harness {
  readonly writeNote: (text: string) => Promise<{ noteId: string; atomIds: string[]; blockedByCode: boolean }>;
  readonly recallItems: { id: string; text: string; score: number }[];
  readonly pinned: string[];
  readonly forgot: string[];
  readonly list?: () => Promise<{
    atoms: readonly unknown[];
    concepts: readonly unknown[];
    procedures: readonly unknown[];
  }>;
  readonly export?: () => Promise<{
    path: string;
    atoms: number;
    concepts: number;
    notes: number;
  }>;
  readonly replay?: () => Promise<{ replayed: number }>;
}

function service(harness: Harness): IAssociativeMemoryService {
  return {
    _serviceBrand: undefined,
    writeNote: harness.writeNote,
    recall: async () => ({ items: harness.recallItems, trace: [] }) as never,
    pin: async (id: string) => {
      harness.pinned.push(id);
    },
    forget: async (id: string) => {
      harness.forgot.push(id);
    },
    list: harness.list as never,
    export: harness.export as never,
    replay: harness.replay as never,
    audit: (async () => []) as never,
    reconsolidate: (async () => ({
      noteId: 'n1',
      atomIds: ['a1'],
      superseded: false,
    })) as never,
    rebuild: (async () => {}) as never,
    stats: async () => ({ atoms: 0, concepts: 0, edges: 0, notes: 0, suppressed: 0, pinned: 0 }),
    explain: async () => [],
    signalBlock: async () => '',
  } as unknown as IAssociativeMemoryService;
}

async function run(
  tool: MemoryGraphTool,
  args: {
    action:
      | 'write'
      | 'recall'
      | 'pin'
      | 'forget'
      | 'list'
      | 'export'
      | 'replay'
      | 'propose'
      | 'approve'
      | 'label'
      | 'reconsolidate'
      | 'audit'
      | 'stats'
      | 'explain'
      | 'rebuild';
    text?: string;
    query?: string;
    id?: string;
    kind?: 'atom' | 'concept';
  },
): Promise<string> {
  const execution = tool.resolveExecution(args);
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  const result = await execution.execute(CONTEXT);
  return typeof result.output === 'string' ? result.output : '';
}

describe('MemoryGraph tool', () => {
  it('writes a note through the service', async () => {
    const harness: Harness = {
      writeNote: async (text) => ({ noteId: 'n1', atomIds: ['a1'], blockedByCode: false, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
    };
    const output = await run(new MemoryGraphTool(service(harness)), {
      action: 'write',
      text: 'hello',
    });
    expect(output).toContain('1');
  });

  it('reports a code block', async () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: true, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
    };
    const output = await run(new MemoryGraphTool(service(harness)), {
      action: 'write',
      text: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(output.length).toBeGreaterThan(0);
  });

  it('recalls and renders items', async () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: false, scope: 'project' }),
      recallItems: [{ id: 'a1', text: 'hello', score: 0.9 }],
      pinned: [],
      forgot: [],
    };
    const output = await run(new MemoryGraphTool(service(harness)), {
      action: 'recall',
      query: 'hello',
    });
    expect(output).toContain('hello');
    expect(output).toContain('a1');
  });

  it('pins and forgets by id', async () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: false, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
    };
    const tool = new MemoryGraphTool(service(harness));
    await run(tool, { action: 'pin', id: 'a1' });
    await run(tool, { action: 'forget', id: 'a2' });
    expect(harness.pinned).toEqual(['a1']);
    expect(harness.forgot).toEqual(['a2']);
  });

  it('lists atoms and concepts', async () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: false, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
      list: async () => ({
        atoms: [{ id: 'a1', text: 'hello' } as never],
        concepts: [{ id: 'c1', label: 'greeting' } as never],
        procedures: [],
      }),
    };
    const output = await run(new MemoryGraphTool(service(harness)), { action: 'list' });
    expect(output).toContain('hello');
    expect(output).toContain('greeting');
  });

  it('exports the memory to a file', async () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: false, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
      export: async () => ({ path: '/tmp/memory-export.json', atoms: 1, concepts: 0, notes: 1 }),
    };
    const output = await run(new MemoryGraphTool(service(harness)), { action: 'export' });
    expect(output).toContain('/tmp/memory-export.json');
  });

  it('describes itself and exposes its parameters', () => {
    const harness: Harness = {
      writeNote: async () => ({ noteId: '', atomIds: [], blockedByCode: false, scope: 'project' }),
      recallItems: [],
      pinned: [],
      forgot: [],
    };
    const tool = new MemoryGraphTool(service(harness));
    expect(tool.name).toBe(MEMORY_GRAPH_TOOL_NAME);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
  });
});
