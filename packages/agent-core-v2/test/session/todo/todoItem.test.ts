import { describe, expect, it } from 'vitest';

import {
  computeTodoProgress,
  readTodoItems,
  renderTodoList,
  type TodoItem,
} from '#/session/todo/todoItem';

const T = (title: string, status: TodoItem['status']): TodoItem => ({
  id: `T${title}`,
  parentId: null,
  kind: 'task',
  title,
  status,
});

describe('readTodoItems', () => {
  it('keeps the new fields and clamps progress into [0, 100]', () => {
    const items = readTodoItems([
      {
        id: 'T1',
        parentId: null,
        kind: 'milestone',
        title: 'M1',
        status: 'in_progress',
        progress: 40,
        description: 'stage one',
      },
      { id: 'T1.1', parentId: 'T1', title: 'leaf', status: 'in_progress', progress: 60 },
      { id: 'T1.2', parentId: 'T1', title: 'leaf2', status: 'pending', progress: 140 },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: 'T1', kind: 'milestone', progress: 40 });
    expect(items[1]).toMatchObject({ id: 'T1.1', parentId: 'T1', kind: 'task' });
    expect(items[2]?.progress).toBe(100);
  });

  it('migrates legacy {title, status} entries: auto id, top-level, kind task', () => {
    const items = readTodoItems([
      { title: 'old a', status: 'pending' },
      { title: 'old b', status: 'done' },
    ]);
    expect(items).toEqual([
      { id: 'T1', parentId: null, kind: 'task', title: 'old a', status: 'pending' },
      { id: 'T2', parentId: null, kind: 'task', title: 'old b', status: 'done' },
    ]);
  });

  it('auto-assigned ids never collide with model-provided ids', () => {
    const items = readTodoItems([
      { id: 'T1', parentId: null, kind: 'milestone', title: 'M1', status: 'pending' },
      { title: 'auto top-level', status: 'pending' },
    ]);
    expect(items.map((item) => item.id)).toEqual(['T1', 'T2']);
  });

  it('drops malformed entries and non-array input', () => {
    expect(readTodoItems('nope')).toEqual([]);
    expect(
      readTodoItems([{ title: 'ok', status: 'done' }, { title: 5, status: 'done' }, null]),
    ).toEqual([{ id: 'T1', parentId: null, kind: 'task', title: 'ok', status: 'done' }]);
  });
});

describe('computeTodoProgress', () => {
  it('leaf progress: done=100, in_progress uses reported progress, pending=0', () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'a', status: 'done' },
      { id: 'T2', parentId: null, kind: 'task', title: 'b', status: 'in_progress', progress: 60 },
      { id: 'T3', parentId: null, kind: 'task', title: 'c', status: 'in_progress' },
      { id: 'T4', parentId: null, kind: 'task', title: 'd', status: 'pending' },
    ];
    const report = computeTodoProgress(todos);
    expect(report.overall).toBe(40);
    expect(report.done).toBe(1);
    expect(report.total).toBe(4);
    expect(report.byId.get('T2')).toBe(60);
    expect(report.byId.get('T3')).toBe(0);
  });

  it('milestone progress is the mean of its children; overall is the mean of milestones', () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'milestone', title: 'M1', status: 'pending' },
      { id: 'T1.1', parentId: 'T1', kind: 'task', title: 'a', status: 'done' },
      { id: 'T1.2', parentId: 'T1', kind: 'task', title: 'b', status: 'in_progress', progress: 50 },
      { id: 'T2', parentId: null, kind: 'milestone', title: 'M2', status: 'pending' },
      { id: 'T2.1', parentId: 'T2', kind: 'task', title: 'c', status: 'pending' },
      { id: 'T2.2', parentId: 'T2', kind: 'task', title: 'd', status: 'pending' },
    ];
    const report = computeTodoProgress(todos);
    expect(report.byId.get('T1')).toBe(75);
    expect(report.byId.get('T2')).toBe(0);
    expect(report.overall).toBe(38);
    expect(report.done).toBe(1);
    expect(report.total).toBe(6);
  });

  it('childless milestone falls back to its own status', () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'milestone', title: 'M1', status: 'done' },
      { id: 'T2', parentId: null, kind: 'milestone', title: 'M2', status: 'pending' },
    ];
    const report = computeTodoProgress(todos);
    expect(report.byId.get('T1')).toBe(100);
    expect(report.byId.get('T2')).toBe(0);
    expect(report.overall).toBe(50);
  });

  it('flat list without milestones: overall is the mean over all items', () => {
    const todos: TodoItem[] = [
      T('a', 'done'),
      T('b', 'pending'),
      T('c', 'pending'),
      T('d', 'pending'),
    ];
    expect(computeTodoProgress(todos).overall).toBe(25);
  });

  it('empty list reports zeros', () => {
    expect(computeTodoProgress([])).toEqual({
      overall: 0,
      done: 0,
      total: 0,
      byId: new Map(),
    });
  });
});

describe('renderTodoList', () => {
  it('renders the tree with indentation, ids, and progress feedback', () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'milestone', title: 'M1 setup', status: 'pending' },
      { id: 'T1.1', parentId: 'T1', kind: 'task', title: 'read config', status: 'done' },
      {
        id: 'T1.2',
        parentId: 'T1',
        kind: 'task',
        title: 'install deps',
        status: 'in_progress',
        progress: 60,
      },
      { id: 'T2', parentId: null, kind: 'milestone', title: 'M2 verify', status: 'pending' },
      { id: 'T2.1', parentId: 'T2', kind: 'task', title: 'run tests', status: 'pending' },
    ];
    const out = renderTodoList(todos);
    expect(out).toContain('overall 1/5 · 40%');
    expect(out).toContain('[in_progress] T1: M1 setup (1/2 · 80%)');
    expect(out).toContain('[done] T1.1: read config');
    expect(out).toContain('[in_progress] T1.2: install deps (60%)');
    expect(out).toContain('[pending] T2: M2 verify (0/1 · 0%)');
  });

  it('legacy flat items render without progress suffix', () => {
    const out = renderTodoList([T('a', 'done'), T('b', 'in_progress')]);
    expect(out).toContain('overall 1/2 · 50%');
    expect(out).toContain('[done] Ta: a');
    expect(out).toContain('[in_progress] Tb: b');
  });

  it('empty list message', () => {
    expect(renderTodoList([])).toBe('Todo list is empty.');
  });
});
