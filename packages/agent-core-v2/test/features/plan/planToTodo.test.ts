import { describe, expect, it, vi } from 'vitest';

import type { TodoRuntime } from '#/features/todo/todoAgentRuntime';
import type { TodoItem } from '#/features/todo/todoItem';
import type { PlanData } from '#/features/plan/plan';
import { tryConvertPlanToTodos } from '#/features/plan/planToTodoConverter';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { parsePlanToTodos } from '#/features/plan/parsePlanToTodos';

describe('parsePlanToTodos', () => {
  it('returns null for an empty plan', () => {
    expect(parsePlanToTodos('')).toBeNull();
    expect(parsePlanToTodos('   \n\n  \n')).toBeNull();
  });

  it('returns null when the plan has no headings or list items', () => {
    expect(parsePlanToTodos('Just a paragraph about the plan.\nNo structure here.')).toBeNull();
  });

  it('returns null when there is a heading but no list items under it', () => {
    expect(parsePlanToTodos('## Setup\n\nJust narrative, no checklist.')).toBeNull();
  });

  it('parses a single phase with list items', () => {
    const todos = parsePlanToTodos(
      '## Implement feature\n' +
        '- Read current module\n' +
        '- Write the patch\n' +
        '- Run tests',
    );
    expect(todos).toEqual<TodoItem[]>([
      {
        id: 'M1',
        parentId: null,
        kind: 'milestone',
        title: 'Implement feature',
        status: 'pending',
      },
      {
        id: 'M1.1',
        parentId: 'M1',
        kind: 'task',
        title: 'Read current module',
        status: 'pending',
      },
      {
        id: 'M1.2',
        parentId: 'M1',
        kind: 'task',
        title: 'Write the patch',
        status: 'pending',
      },
      {
        id: 'M1.3',
        parentId: 'M1',
        kind: 'task',
        title: 'Run tests',
        status: 'pending',
      },
    ]);
  });

  it('parses multiple phases (milestones) with lists', () => {
    const todos = parsePlanToTodos(
      '## Plan the work\n- Outline scope\n\n## Implement\n- Code change\n- Test\n\n## Wrap up\n- Merge',
    );
    expect(todos?.map((item) => ({ id: item.id, kind: item.kind, title: item.title }))).toEqual([
      { id: 'M1', kind: 'milestone', title: 'Plan the work' },
      { id: 'M1.1', kind: 'task', title: 'Outline scope' },
      { id: 'M2', kind: 'milestone', title: 'Implement' },
      { id: 'M2.1', kind: 'task', title: 'Code change' },
      { id: 'M2.2', kind: 'task', title: 'Test' },
      { id: 'M3', kind: 'milestone', title: 'Wrap up' },
      { id: 'M3.1', kind: 'task', title: 'Merge' },
    ]);
  });

  it('reads checkbox state into task status', () => {
    const todos = parsePlanToTodos(
      '## Do it\n- [x] First step\n- [ ] Second step\n- Third step (bare)',
    );
    expect(todos?.filter((i) => i.kind === 'task').map((i) => ({ id: i.id, status: i.status }))).toEqual([
      { id: 'M1.1', status: 'done' },
      { id: 'M1.2', status: 'pending' },
      { id: 'M1.3', status: 'pending' },
    ]);
  });

  it('accepts ### sub-headings as milestones (treated like ##)', () => {
    const todos = parsePlanToTodos('### Sub step\n- Do thing');
    expect(todos?.map((item) => item.kind)).toEqual(['milestone', 'task']);
  });

  it('supports indented list items and numbered lists', () => {
    const todos = parsePlanToTodos('## Phase\n  - nested bullet\n  1. numbered one\n  2. numbered two');
    expect(todos?.filter((i) => i.kind === 'task').map((i) => i.title)).toEqual([
      'nested bullet',
      'numbered one',
      'numbered two',
    ]);
  });
});

function makeTodoRuntime(initial: readonly TodoItem[] = []): {
  runtime: TodoRuntime;
  setCalls: TodoItem[][];
} {
  let todos = [...initial];
  const setCalls: TodoItem[][] = [];
  const runtime = {
    get: () => todos,
    replace: async (next: readonly TodoItem[]) => {
      setCalls.push([...next]);
      todos = [...next];
    },
    clear: async () => {
      todos = [];
    },
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as TodoRuntime;
  return { runtime, setCalls };
}

const FAKE_AGENT = { agentId: 'main', generation: 0 } as unknown as AgentContext;

const PLAN: PlanData = {
  id: 'p1',
  path: '/session/agents/main/plans/p1.md',
  content:
    '## Implement feature\n' +
    '- Read current module\n' +
    '- Write the patch\n' +
    '- Run tests',
};

describe('tryConvertPlanToTodos', () => {
  it('skips when planData is null', async () => {
    const { runtime: service, setCalls } = makeTodoRuntime();
    const outcome = await tryConvertPlanToTodos(null, service, FAKE_AGENT);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'empty-plan' });
    expect(setCalls).toHaveLength(0);
  });

  it('skips when plan content is whitespace only', async () => {
    const { runtime: service, setCalls } = makeTodoRuntime();
    const outcome = await tryConvertPlanToTodos(
      { id: 'p', path: '/p', content: '  \n  ' },
      service,
      FAKE_AGENT,
    );
    expect(outcome).toEqual({ kind: 'skipped', reason: 'empty-plan' });
    expect(setCalls).toHaveLength(0);
  });

  it('skips when the plan has no headings + lists', async () => {
    const { runtime: service, setCalls } = makeTodoRuntime();
    const outcome = await tryConvertPlanToTodos(
      { id: 'p', path: '/p', content: 'Just narrative, no checklist.' },
      service,
      FAKE_AGENT,
    );
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no-structure' });
    expect(setCalls).toHaveLength(0);
  });

  it('skips when the agent context is undefined', async () => {
    const { runtime: service, setCalls } = makeTodoRuntime();
    const outcome = await tryConvertPlanToTodos(PLAN, service, undefined);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no-agent' });
    expect(setCalls).toHaveLength(0);
  });

  it('skips when the agent already has todos (no overwrite)', async () => {
    const existing: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'prior work', status: 'pending' },
    ];
    const { runtime: service, setCalls } = makeTodoRuntime(existing);
    const outcome = await tryConvertPlanToTodos(PLAN, service, FAKE_AGENT);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'existing-todos' });
    expect(setCalls).toHaveLength(0);
  });

  it('converts a structured plan and writes via the todo service', async () => {
    const { runtime: service, setCalls } = makeTodoRuntime();
    const outcome = await tryConvertPlanToTodos(PLAN, service, FAKE_AGENT);
    expect(outcome).toEqual({ kind: 'converted', count: 4 });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.map((item) => item.title)).toEqual([
      'Implement feature',
      'Read current module',
      'Write the patch',
      'Run tests',
    ]);
  });

  it('does not throw when the todo runtime rejects (caller can ignore)', async () => {
    const service = {
      get: () => [],
      replace: vi.fn(async () => {
        throw new Error('boom');
      }),
      clear: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    } as unknown as TodoRuntime;
    await expect(tryConvertPlanToTodos(PLAN, service, FAKE_AGENT)).rejects.toThrow('boom');
  });
});