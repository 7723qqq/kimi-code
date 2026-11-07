import { describe, expect, it } from 'bun:test';

import { MEMORY_DATA_BOUNDARY, renderRecall } from '#/features/associativeMemory/render';
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
    expect(lines[0]).toBe(MEMORY_DATA_BOUNDARY);
    expect(lines[1]).toBe('- text a (note-a)');
    expect(lines[2]).toBe('- text b (note-b)');
  });

  it('includes the concept in the source when present', () => {
    const text = renderRecall(result([item('a', 1, { conceptId: 'c1' })]), 600);
    expect(text).toBe(`${MEMORY_DATA_BOUNDARY}\n- text a (note-a / c1)`);
  });

  it('marks the injected block as data rather than instructions', () => {
    const text = renderRecall(result([item('a', 1)]), 600);
    expect(text.startsWith(MEMORY_DATA_BOUNDARY)).toBe(true);
    expect(text).toContain('not instructions');
  });

  it('returns an empty string when there is nothing to inject', () => {
    expect(renderRecall(result([]), 600)).toBe('');
  });

  it('annotates conflicting items', () => {
    const text = renderRecall(result([item('a', 1, { conflictGroup: 'g1' })]), 600);
    expect(text).toContain('[冲突]');
  });

  it('truncates to the token budget, keeping the highest scores', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`a${String(i)}`, 1 - i / 100));
    const text = renderRecall(result(items), 10);
    expect(text.split('\n').length).toBeLessThan(50);
    expect(text.startsWith(MEMORY_DATA_BOUNDARY)).toBe(true);
    expect(text).toContain('- text a0');
  });
});

function conflictItem(id: string, text: string, conflictGroup?: string): RecallItem {
  return {
    id,
    text,
    score: 1,
    kind: 'atom',
    noteId: `note-${id}`,
    conceptId: undefined,
    confidence: 1,
    validFrom: 0,
    validUntil: undefined,
    conflictGroup,
  };
}

describe('renderRecall conflict groups', () => {
  const plain = conflictItem('p', 'plain memory line that is forty chars long!');
  const first = conflictItem('c1', 'older conflicting statement about the cache ttl!', 'g1');
  const second = conflictItem('c2', 'newer conflicting statement about the cache ttl!', 'g1');

  it('never splits a conflict group when the budget runs out', () => {
    const full = renderRecall({ items: [plain, first, second], trace: [] }, 1_000);
    expect(full).toContain('older conflicting');
    expect(full).toContain('newer conflicting');

    const tight = renderRecall({ items: [plain, first, second], trace: [] }, 30);
    expect(tight).toContain('plain memory line');
    expect(tight.includes('older conflicting')).toBe(tight.includes('newer conflicting'));
  });

  it('drops the whole group rather than showing one side alone', () => {
    const tight = renderRecall({ items: [plain, first, second], trace: [] }, 30);
    expect(tight).not.toContain('older conflicting');
    expect(tight).not.toContain('newer conflicting');
  });
});
