import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { KnowledgeEntry, KnowledgeSearchResult } from '#/agent/knowledge/knowledge';
import * as knowledge from '#/agent/knowledge/sqliteKnowledge';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowledge-'));
  knowledge.knowledgeOpen(join(dir, 'knowledge.db'));
});

afterEach(() => {
  knowledge.knowledgeClose();
  rmSync(dir, { recursive: true, force: true });
});

function add(
  title: string,
  category = 'coding-style',
  content = 'Content.',
  tags = '',
  scope: string | null = null,
  source = 'human',
  confidence = 1.0,
): KnowledgeEntry {
  return JSON.parse(
    knowledge.knowledgeAdd(title, category, content, tags, scope, source, confidence),
  ) as KnowledgeEntry;
}

function search(
  query = '',
  scopePath: string | null = null,
  tags: string | null = null,
  limit = 10,
  minConfidence = 0,
): KnowledgeSearchResult[] {
  return JSON.parse(
    knowledge.knowledgeSearch(query, scopePath, tags, limit, minConfidence),
  ) as KnowledgeSearchResult[];
}

function stats(): { total: number; by_category: Record<string, number>; by_source: Record<string, number>; avg_confidence: number } {
  return JSON.parse(knowledge.knowledgeStats()) as {
    total: number;
    by_category: Record<string, number>;
    by_source: Record<string, number>;
    avg_confidence: number;
  };
}

describe('knowledge store', () => {
  it('opens an empty database', () => {
    expect(stats().total).toBe(0);
  });

  it('returns the stored entry as json', () => {
    const entry = add('Rust lifetimes', 'coding-style', 'Prefer explicit lifetimes.');
    expect(entry.title).toBe('Rust lifetimes');
    expect(entry.category).toBe('coding-style');
    expect(entry.source).toBe('human');
    expect(entry.confidence).toBe(1);
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.created_at.length).toBeGreaterThan(0);
  });

  it('finds entries through full-text search', () => {
    add('Error handling', 'pitfall', 'Always propagate errors with context.');
    add('Naming', 'coding-style', 'Use snake_case for functions.');
    const results = search('error');
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.title).toBe('Error handling');
    expect(results[0]?.match_source).toContain('fts');
  });

  it('returns nothing for a term that is absent', () => {
    add('Naming', 'coding-style', 'Use snake_case for functions.');
    expect(search('zzzznope')).toHaveLength(0);
  });

  it('matches scope as a directory prefix with boundary checks', () => {
    add('Scoped rule', 'coding-style', 'Scope-specific guidance.', '', 'G:/repo');
    add('Global rule', 'coding-style', 'Works everywhere.');

    const under = search('', 'G:/repo/src');
    expect(under).toHaveLength(2);
    expect(under[0]?.entry.title).toBe('Scoped rule');

    const unrelated = search('', 'G:/other');
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]?.entry.title).toBe('Global rule');

    expect(search('', 'G:/repo-old/x')).toHaveLength(1);

    for (const candidate of ['G:/repo', 'G:/repo/', 'G:\\repo', 'G:/repo/src/main.rs']) {
      const matched = search('', candidate);
      expect(matched, candidate).toHaveLength(2);
      expect(matched[0]?.entry.title).toBe('Scoped rule');
    }
  });

  it('treats quotes in a natural-language query as searchable text', () => {
    add('Foo bar rule', 'pitfall', 'foo bar is the rule.');
    const results = search('foo "bar');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.entry.title).toBe('Foo bar rule');
    expect(results[0]?.match_source).toContain('fts');
  });

  it('reports an unparseable match expression instead of an empty result', () => {
    add('Foo bar rule', 'pitfall', 'foo bar is the rule.');
    expect(() => search('   ')).toThrow();
  });

  it('scores overlapping tags', () => {
    add('Tagged rule', 'pitfall', 'Content.', 'rust,async');
    const results = search('', null, 'rust');
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.title).toBe('Tagged rule');
    expect(results[0]?.match_source).toContain('tag');
  });

  it('filters by minimum confidence', () => {
    add('Low confidence', 'pitfall', 'Maybe wrong.', '', null, 'ai-learned', 0.3);
    add('High confidence', 'coding-style', 'Definitely right.');
    const results = search('', '/', null, 10, 0.8);
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.title).toBe('High confidence');
  });

  it('truncates to the requested limit', () => {
    for (let index = 0; index < 5; index += 1) {
      add(`Rule ${String(index)}`, 'coding-style', 'Shared content body.');
    }
    expect(search('', '/', null, 2)).toHaveLength(2);
  });

  it('removes entries and reports a missing id', () => {
    const entry = add('To remove', 'pitfall', 'Remove me.');
    expect(knowledge.knowledgeRemove(entry.id)).toBe(true);
    expect(search('remove')).toHaveLength(0);
    expect(knowledge.knowledgeRemove(entry.id)).toBe(false);
  });

  it('confirms an entry by raising confidence and switching source', () => {
    const entry = add('AI learned', 'pitfall', 'Content.', '', null, 'ai-learned', 0.4);
    expect(knowledge.knowledgeConfirm(entry.id)).toBe(true);
    const results = search('Content', null, null, 10, 1.0);
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.source).toBe('ai-confirmed');
    expect(results[0]?.entry.confidence).toBe(1);
    expect(knowledge.knowledgeConfirm('missing-id')).toBe(false);
  });

  it('groups stats by category and source', () => {
    add('A', 'coding-style', 'One.');
    add('B', 'coding-style', 'Two.');
    add('C', 'pitfall', 'Three.');
    const summary = stats();
    expect(summary.total).toBe(3);
    expect(summary.by_category['coding-style']).toBe(2);
    expect(summary.by_category['pitfall']).toBe(1);
    expect(summary.by_source['human']).toBe(3);
    expect(summary.avg_confidence).toBe(1);
  });

  it('imports markdown blocks', () => {
    const markdown = [
      '# coding-style:Imported Rule',
      'tags: rust, style',
      'scope: G:/repo',
      '',
      'This is the body.',
      'Second line.',
      '---',
      '# pitfall:Second Entry',
      'Content only.',
      '',
    ].join('\n');
    const entries = JSON.parse(knowledge.knowledgeImport(markdown)) as KnowledgeEntry[];
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    expect(first?.title).toBe('Imported Rule');
    expect(first?.category).toBe('coding-style');
    expect(first?.tags).toEqual(['rust', 'style']);
    expect(first?.scope).toBe('G:/repo');
    expect(first?.content).toBe('This is the body.\nSecond line.');
    expect(first?.source).toBe('human');
    expect(second?.title).toBe('Second Entry');
    expect(second?.tags).toEqual([]);
    expect(second?.content).toBe('Content only.');
    expect(search('imported')).toHaveLength(1);
  });

  it('skips malformed import blocks', () => {
    const markdown = [
      '# NoColonTitle',
      'Content.',
      '---',
      '# coding-style:Valid',
      'Good content.',
      '---',
      '# pitfall:Empty body',
      '---',
      '',
    ].join('\n');
    const entries = JSON.parse(knowledge.knowledgeImport(markdown)) as KnowledgeEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('Valid');
  });

  it('rejects an unknown category', () => {
    expect(() => knowledge.knowledgeAdd('Bad', 'not-a-category', 'Content.', '', null, 'human', 1)).toThrow(
      /CHECK/i,
    );
  });

  it('reports operations before open', () => {
    knowledge.knowledgeClose();
    expect(() => knowledge.knowledgeAdd('X', 'pitfall', 'Y', '', null, 'human', 1)).toThrow(
      /not opened/i,
    );
    expect(() => knowledge.knowledgeStats()).toThrow(/not opened/i);
  });

  it('replaces the previously opened database', () => {
    add('Old data', 'pitfall', 'From the first database.');
    const second = mkdtempSync(join(tmpdir(), 'knowledge-'));
    try {
      knowledge.knowledgeOpen(join(second, 'kb2.db'));
      expect(search('', '/')).toHaveLength(0);
    } finally {
      knowledge.knowledgeClose();
      rmSync(second, { recursive: true, force: true });
    }
  });
});
