/**
 * TUI2 todo panel — milestone tree / progress report unit tests.
 *
 * The view (`TodoPanelView`) reads `store.state.todoItems`; these pin the
 * pure logic ported from v1 (`buildTodoTree`, `computePanelProgress`,
 * braille / status-bar cell math) that drives the header and the
 * milestone tree rendering.
 */

import { describe, expect, it } from 'vitest'

import {
  brailleCellLevels,
  buildTodoTree,
  computePanelProgress,
  statusBarFillCount,
} from '@/tui2/components/chrome/todo-panel'
import type { PanelTodoItem } from '@/tui2/components/chrome/todo-panel'

const milestone = (id: string, title: string, overrides?: Partial<PanelTodoItem>): PanelTodoItem => ({
  id,
  title,
  kind: 'milestone',
  status: 'pending',
  parentId: null,
  ...overrides,
});

const task = (
  id: string,
  title: string,
  parentId: string,
  status: PanelTodoItem['status'],
  progress?: number,
): PanelTodoItem => ({ id, title, status, parentId, kind: 'task', progress });

describe('buildTodoTree', () => {
  it('nests tasks under their parent milestone and orphans stay top-level', () => {
    const todos = [
      milestone('m1', 'Phase one'),
      task('t1', 'first', 'm1', 'done'),
      task('t2', 'second', 'm1', 'in_progress'),
      milestone('m2', 'Unknown parent', { parentId: 'missing' }),
    ];
    const roots = buildTodoTree(todos);
    expect(roots.map((node) => node.item.id)).toEqual(['m1', 'm2']);
    expect(roots[0]?.children.map((node) => node.item.id)).toEqual(['t1', 't2']);
    expect(roots[1]?.children).toEqual([]);
  });

  it('ignores self-referencing parents and falls back to titles without ids', () => {
    const todos = [
      { title: 'solo', status: 'pending' } as PanelTodoItem,
      { title: 'self', status: 'pending', parentId: 'self' } as PanelTodoItem,
    ];
    const roots = buildTodoTree(todos);
    expect(roots).toHaveLength(2);
    expect(roots.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe('computePanelProgress', () => {
  it('averages leaf progress into milestones and rolls up the overall percent', () => {
    const todos = [
      milestone('m1', 'Phase one'),
      task('t1', 'first', 'm1', 'done'),
      task('t2', 'second', 'm1', 'in_progress', 50),
      milestone('m2', 'Phase two'),
      task('t3', 'third', 'm2', 'pending'),
    ];
    const report = computePanelProgress(todos);
    expect(report.byId.get('m1')).toBe(75); // mean(100, 50)
    expect(report.byId.get('m2')).toBe(0);
    expect(report.overall).toBe(38); // round(mean(75, 0))
    expect(report.done).toBe(1); // only the finished leaf task t1
    expect(report.total).toBe(5);
  });

  it('counts a milestone done once its progress reaches 100', () => {
    const todos = [
      milestone('m1', 'Only phase'),
      task('t1', 'only task', 'm1', 'done'),
    ];
    const report = computePanelProgress(todos);
    expect(report.byId.get('m1')).toBe(100);
    // Both the completed milestone and its finished leaf task count.
    expect(report.done).toBe(2);
    expect(report.overall).toBe(100);
  });

  it('falls back to plain per-item progress without milestones', () => {
    const todos: PanelTodoItem[] = [
      { title: 'a', status: 'done' },
      { title: 'b', status: 'in_progress' },
      { title: 'c', status: 'pending' },
    ];
    const report = computePanelProgress(todos);
    expect(report.overall).toBe(33); // round(mean(100, 0, 0))
    expect(report.done).toBe(1);
    expect(report.total).toBe(3);
  });

  it('returns a zero report for an empty list', () => {
    expect(computePanelProgress([])).toEqual({
      overall: 0,
      done: 0,
      total: 0,
      byId: new Map(),
    });
  });
});

describe('progress bar cell math', () => {
  it('brailleCellLevels distributes ticks across cells', () => {
    expect(brailleCellLevels(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(brailleCellLevels(100, 5)).toEqual([6, 6, 6, 6, 6]);
    // Half full → the leading cells saturate at the top braille level.
    const half = brailleCellLevels(50, 4);
    expect(half).toEqual([6, 6, 0, 0]);
    expect(brailleCellLevels(50, 0)).toEqual([]);
  });

  it('brailleCellLevels clamps out-of-range percents', () => {
    expect(brailleCellLevels(-10, 2)).toEqual([0, 0]);
    expect(brailleCellLevels(Number.NaN, 2)).toEqual([0, 0]);
    expect(brailleCellLevels(150, 2)).toEqual([6, 6]);
  });

  it('statusBarFillCount rounds the filled portion', () => {
    expect(statusBarFillCount(0, 10)).toBe(0);
    expect(statusBarFillCount(50, 10)).toBe(5);
    expect(statusBarFillCount(100, 10)).toBe(10);
    expect(statusBarFillCount(33, 10)).toBe(3);
  });
});
