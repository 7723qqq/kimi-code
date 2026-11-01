/**
 * The journal is the artefact a human reviews, so the way it renders is behaviour.
 *
 * No suite covered `journalToMarkdown` until this one, which is why a diff silently
 * cut at 40 lines went unnoticed: the rendering looked right in every case small
 * enough to read in a test. A truncated diff is the one defect that matters here,
 * because a reviewer who cannot tell a summary from the whole change will approve
 * a journal that does not contain the change.
 */
import { describe, expect, it } from 'bun:test';

import { DIFF_LINE_LIMIT, journalToMarkdown, summarize } from '../src/report.mjs';

const META = {
  createdAt: '2026-01-01T00:00:00.000Z',
  root: '/tmp/p',
  bun: '1.4.4',
  layers: ['source'],
};

function journalOf(changes, skipped = [], name = 'source') {
  return {
    layers: () => [{ name, changes, skipped }],
  };
}

function edit(file, before, after, detail = 'rewrote one call') {
  return { kind: 'edit', layer: 'source', file, detail, before, after };
}

function lines(count, prefix) {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join('\n');
}

describe('summarize', () => {
  it('counts edits, removals and skips separately', () => {
    const journal = {
      layers: () => [
        {
          name: 'source',
          changes: [edit('a.ts', 'a', 'b')],
          skipped: [{ file: 'b.ts', reason: 'r' }],
        },
      ],
      changes: [edit('a.ts', 'a', 'b')],
      removals: [{ file: 'pnpm-lock.yaml' }],
    };
    const report = summarize({ root: '/tmp/p' }, journal, 'scan');
    expect(report.summary).toContain('1 file change(s)');
    expect(report.summary).toContain('1 removal(s)');
    expect(report.summary).toContain('1 skipped');
    expect(report.summary).toContain('dry run');
  });

  it('says written for apply rather than dry run', () => {
    const journal = { layers: () => [], changes: [], removals: [] };
    expect(summarize({ root: '/tmp/p' }, journal, 'apply').summary).toContain('written');
  });
});

describe('journalToMarkdown', () => {
  it('renders a short diff in full and does not claim truncation', () => {
    const markdown = journalToMarkdown(journalOf([edit('a.ts', 'one\ntwo\n', 'one\nTWO\n')]), META);
    expect(markdown).toContain('  - one');
    expect(markdown).toContain('  + TWO');
    expect(markdown.includes('truncated')).toBe(false);
  });

  it('announces truncation instead of silently cutting the diff', () => {
    const markdown = journalToMarkdown(
      journalOf([edit('big.ts', lines(100, 'old'), lines(100, 'NEW'))]),
      META,
    );
    expect(markdown).toContain('truncated');
    expect(markdown).toContain(`showing ${DIFF_LINE_LIMIT} of 100`);
    expect(markdown).toContain('read the file or the .json journal for the rest');
  });

  it('shows exactly the limit lines when truncating', () => {
    const markdown = journalToMarkdown(
      journalOf([edit('big.ts', lines(100, 'old'), lines(100, 'NEW'))]),
      META,
    );
    const before = markdown.split('\n').filter((line) => line.startsWith('  - ')).length;
    const after = markdown.split('\n').filter((line) => line.startsWith('  + ')).length;
    expect(before).toBe(DIFF_LINE_LIMIT);
    expect(after).toBe(DIFF_LINE_LIMIT);
  });

  it('does not announce truncation at exactly the limit', () => {
    const markdown = journalToMarkdown(
      journalOf([edit('edge.ts', lines(DIFF_LINE_LIMIT, 'old'), lines(DIFF_LINE_LIMIT, 'NEW'))]),
      META,
    );
    expect(markdown.includes('truncated')).toBe(false);
  });

  it('renders a note without a file or a diff', () => {
    const markdown = journalToMarkdown(
      journalOf([{ kind: 'note', layer: 'source', detail: 'run bun install next' }]),
      META,
    );
    expect(markdown).toContain('_note_: run bun install next');
    expect(markdown.includes('```diff')).toBe(false);
  });

  it('renders a remove entry without inventing a diff', () => {
    const markdown = journalToMarkdown(
      journalOf([{ kind: 'remove', layer: 'source', file: 'pnpm-lock.yaml', detail: 'converted' }]),
      META,
    );
    expect(markdown).toContain('**remove** `pnpm-lock.yaml`');
    expect(markdown.includes('```diff')).toBe(false);
  });

  it('lists every skip reason under its layer', () => {
    const markdown = journalToMarkdown(
      journalOf([], [{ file: 'a.test.ts', reason: 'snapshot key differs' }]),
      META,
    );
    expect(markdown).toContain('Skipped:');
    expect(markdown).toContain('`a.test.ts` — snapshot key differs');
  });

  it('leaves out a layer that changed nothing and skipped nothing', () => {
    const markdown = journalToMarkdown(journalOf([], []), META);
    expect(markdown.includes('## source')).toBe(false);
    expect(markdown).toContain('| source | 0 | 0 |');
  });
});
