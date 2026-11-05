import { describe, expect, it } from 'bun:test';

import { renderRecall } from '#/features/associativeMemory/render';
import type { RecallItem, RecallResult } from '#/features/associativeMemory/types';

function item(id: string, score: number, overrides: Partial<RecallItem> = {}): RecallItem {
  return {
    id,
    kind: 'atom',
    text: `text ${id}`,
    score,
    noteId: `note-${id}`,
    conceptId: undefined,
    confidence: 1,
    validFrom: 0,
    validUntil: undefined,
    conflictGroup: undefined,
    ...overrides,
  };
}

function result(items: readonly RecallItem[]): RecallResult {
  return { items, trace: [] };
}

describe('renderRecall', () => {
  it('renders each item with its source, ordered by score', () => {
    const text = renderRecall(result([item('a', 0.9), item('b', 0.5)]), 600);
    const lines = text.split('\n');
    expect(lines[0]).toBe('- text a (note-a)');
    expect(lines[1]).toBe('- text b (note-b)');
  });

  it('includes the concept in the source when present', () => {
    const text = renderRecall(result([item('a', 1, { conceptId: 'c1' })]), 600);
    expect(text).toBe('- text a (note-a / c1)');
  });

  it('annotates conflicting items', () => {
    const text = renderRecall(result([item('a', 1, { conflictGroup: 'g1' })]), 600);
    expect(text).toContain('[冲突]');
  });

  it('truncates to the token budget, keeping the highest scores', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`a${String(i)}`, 1 - i / 100));
    const text = renderRecall(result(items), 10);
    expect(text.split('\n').length).toBeLessThan(50);
    expect(text.startsWith('- text a0')).toBe(true);
  });
});
