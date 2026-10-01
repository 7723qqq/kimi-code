import { afterEach, describe, expect, it } from 'vitest';

import { setLocale, t } from '#/i18n';
import {
  parseGlobOutput,
  parseGrepOutput,
  searchNoticeOnly,
} from '#/tui/components/messages/tool-renderers/grep-output';
import type { ToolCallBlockData } from '#/tui/types';

/**
 * The engine renders its own Grep / Glob notices through the locale catalog
 * (`engine.tools.grep.*` in `tools/mod.rs`), so the notice a user sees is
 * already in their language. The TUI has to recognise those lines for what
 * they are, or it counts a sentence as a search result.
 *
 * Every line below is built from the catalog through `t()` with the same
 * arguments the engine passes, so the test tracks the wording instead of
 * freezing a copy of it. A literal Chinese string here would pass against a
 * catalog the engine no longer uses.
 */
function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

afterEach(() => {
  setLocale('en');
});

describe('Grep / Glob notices in the active locale', () => {
  it('does not count a localized no-match notice as a result file', () => {
    setLocale('zh');
    const stats = parseGrepOutput(
      call('Grep', { pattern: 'foo' }),
      t('engine.tools.grep.noMatches', { pattern: 'foo' }),
    );
    expect(stats.entries).toEqual([]);
    expect(stats.files).toBe(0);
  });

  it('does not count a localized sensitive-filter notice as a result file', () => {
    setLocale('zh');
    const notice = t('engine.tools.grep.filteredSensitive', { filtered_sensitive: 2 });
    const stats = parseGrepOutput(call('Grep', { pattern: 'foo' }), `${notice}\na.ts\nb.ts`);
    expect(stats.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('reads the totals out of a localized count-mode summary', () => {
    setLocale('zh');
    // Same arguments `tools/mod.rs` binds: two numbers and the English scope /
    // singular-plural words, which the catalog places in its own order.
    const summary = t('engine.tools.grep.foundAcross', {
      total_occurrences: 5,
      scope: 'total',
      occurrence_word: 'occurrences',
      files: 2,
      file_word: 'files',
    });
    const stats = parseGrepOutput(
      call('Grep', { pattern: 'foo', output_mode: 'count_matches' }),
      `${summary}\nsrc/a.ts:3\nsrc/b.ts:2`,
    );
    expect(stats.matches).toBe(5);
    expect(stats.files).toBe(2);
  });

  it('treats a localized all-sensitive result as a notice, not an empty search', () => {
    setLocale('zh');
    const notice = t('engine.tools.grep.noNonSensitive');
    const output = notice;
    expect(searchNoticeOnly(call('Grep', { pattern: 'foo' }), output)).toBe(true);
  });

  it('finds a localized notice that a diagnostic line precedes', () => {
    // `searchNoticeOnly` matches against the whole result, so the pattern has to
    // find the notice on a later line — the anchored source alone would only
    // ever match at offset 0.
    setLocale('zh');
    const output = ['rg: .git: Permission denied', t('engine.tools.grep.noNonSensitiveFiltered', { filtered_sensitive: 1 })].join('\n');
    expect(searchNoticeOnly(call('Grep', { pattern: 'foo' }), output)).toBe(true);
  });

  it('leaves a localized Glob no-match notice out of the file count', () => {
    setLocale('zh');
    const output = t('engine.tools.grep.noFilesMatched', { pattern: '*.ts' });
    expect(parseGlobOutput(output).entries).toEqual([]);
    // Not a notice-only card: an empty search still reports "no files".
    expect(searchNoticeOnly(call('Glob', { pattern: '*.ts' }), output)).toBe(false);
  });

  it('treats a localized Glob past-the-end notice as a notice', () => {
    setLocale('zh');
    const output = t('engine.tools.grep.noMoreMatches', { offset: 100, total: 100 });
    expect(parseGlobOutput(output).entries).toEqual([]);
    expect(searchNoticeOnly(call('Glob', { pattern: '*.ts' }), output)).toBe(true);
  });

  it('leaves a localized Glob sensitive-filter notice out of the file count', () => {
    setLocale('zh');
    const output = t('engine.tools.grep.noNonSensitiveFiltered', { filtered_sensitive: 1 });
    expect(parseGlobOutput(output).entries).toEqual([]);
    expect(searchNoticeOnly(call('Glob', { pattern: '*.ts' }), output)).toBe(true);
  });

  it('reads a localized Glob paging report and keeps the rows', () => {
    setLocale('zh');
    const page = t('engine.tools.glob.showingMatches', { from: 1, to: 2, total: 4 });
    const stats = parseGlobOutput([page, 'a.ts', 'b.ts'].join('\n'));
    expect(stats.entries).toEqual(['a.ts', 'b.ts']);
    // The window ends before the total, so the count is a lower bound.
    expect(stats.partial).toBe(true);
  });

  it('treats a localized last page as complete', () => {
    setLocale('zh');
    const page = t('engine.tools.glob.showingMatches', { from: 3, to: 4, total: 4 });
    const stats = parseGlobOutput([page, 'c.ts', 'd.ts'].join('\n'));
    expect(stats.entries).toEqual(['c.ts', 'd.ts']);
    expect(stats.partial).toBe(false);
  });

  it('still recognizes English notices after the user switches locale', () => {
    // A transcript keeps the wording it was written with, so the parser has to
    // keep matching the language the engine no longer emits. Building the line
    // from the catalog in English and then switching to Chinese is also what
    // pins the hand-written English fallbacks in `grep-output.ts` to the live
    // catalog: a reworded template stops matching and this goes red.
    const cases: { key: string; params: Record<string, string | number> }[] = [
      { key: 'engine.tools.grep.noMatches', params: { pattern: 'foo' } },
      { key: 'engine.tools.grep.noNonSensitive', params: {} },
      { key: 'engine.tools.grep.noNonSensitiveFiltered', params: { filtered_sensitive: 2 } },
      { key: 'engine.tools.grep.noMoreMatches', params: { offset: 100, total: 100 } },
      { key: 'engine.tools.grep.noFilesMatched', params: { pattern: '*.ts' } },
      { key: 'engine.tools.grep.filteredSensitive', params: { filtered_sensitive: 1 } },
      { key: 'engine.tools.grep.filteredSensitiveWithList', params: { count: 1, list: '.env' } },
    ];

    for (const { key, params } of cases) {
      setLocale('en');
      const english = t(key, params);
      setLocale('zh');
      expect(parseGrepOutput(call('Grep', { pattern: 'foo' }), english).entries, key).toEqual([]);
      expect(parseGlobOutput(english).entries, key).toEqual([]);
    }
  });

  it('keeps the Glob paging report a Grep row, and the other way round', () => {
    // The paging report is Glob-only, so it is stripped on the Glob side and
    // left alone on the Grep side — a Grep result has no such line, and treating
    // it as a notice there would silently drop a real row.
    setLocale('zh');
    const page = t('engine.tools.glob.showingMatches', { from: 1, to: 2, total: 4 });
    expect(parseGlobOutput(page).entries).toEqual([]);
    expect(parseGrepOutput(call('Grep', { pattern: 'foo' }), page).entries.map((e) => e.path)).toEqual([page]);

    setLocale('en');
    const english = t('engine.tools.glob.showingMatches', { from: 1, to: 2, total: 4 });
    setLocale('zh');
    expect(parseGlobOutput(english).entries).toEqual([]);
    expect(parseGrepOutput(call('Grep', { pattern: 'foo' }), english).entries.map((e) => e.path)).toEqual([english]);
  });
});
