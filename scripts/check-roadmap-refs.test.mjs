import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXEMPT_PATHS,
  analyzeLedger,
  citedPaths,
  findMissingTests,
  resolvesSomewhere,
} from './check-roadmap-refs.mjs';

/**
 * The resolver is injected everywhere below, so these cases describe the
 * *classification* rather than this repository's current file list: a test that
 * needs a real file to exist breaks the day that file moves.
 */
const NOTHING_RESOLVES = () => false;

/** A ledger fragment shaped like the §6.1-20 sentence that hid a dead path. */
const BARE_DEAD = 'fork 的 `packages/kimi-agent/src/server/fs_watch.rs` 是**定时轮询** `tokio::fs::metadata`。';

describe('citedPaths', () => {
  it('extracts a citation that carries a line number', () => {
    const found = citedPaths('see `src/hooks/frontmatter.rs:12` for the parser');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'src/hooks/frontmatter.rs', line: 12, hasLine: true });
  });

  it('extracts a bare path too — requiring ":line" is what left 235 unchecked', () => {
    const found = citedPaths(BARE_DEAD);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'packages/kimi-agent/src/server/fs_watch.rs', hasLine: false });
  });

  it('does not match a prefix of a longer extension', () => {
    const found = citedPaths('`apps/kimi-inspect/src/components/ModelCatalogView.tsx:368`');
    expect(found.map((c) => c.path)).toEqual(['apps/kimi-inspect/src/components/ModelCatalogView.tsx']);
    expect(found[0].line).toBe(368);
  });
});

describe('analyzeLedger', () => {
  it('reports a bare citation to a file that does not exist', () => {
    const { counts, missingFiles } = analyzeLedger(BARE_DEAD, { resolves: NOTHING_RESOLVES, exempt: [] });
    expect(missingFiles.map((m) => m.path)).toEqual(['packages/kimi-agent/src/server/fs_watch.rs']);
    expect(counts.missing).toBe(1);
    expect(counts.bare).toBe(1);
    expect(counts.withLine).toBe(0);
  });

  it('reports a citation that carries a line number, as it always did', () => {
    const { missingFiles } = analyzeLedger('see `src/gone.rs:12`', { resolves: NOTHING_RESOLVES, exempt: [] });
    expect(missingFiles).toEqual([{ path: 'src/gone.rs', lines: [1] }]);
  });

  it('does not report an upstream citation — prefixed or relative to the upstream root', () => {
    const { counts, missingFiles } = analyzeLedger(
      'upstream: `packages/agent-core-v2/src/app/telemetry/events.ts` and `test/agent/x/x.test.ts`',
      { resolves: NOTHING_RESOLVES, exempt: [] },
    );
    expect(missingFiles).toEqual([]);
    expect(counts.upstream).toBe(2);
    expect(counts.checked).toBe(0);
  });

  it('does not report a citation inside a historical block', () => {
    const ledger = '> **订正**：`src/server/ws_v3.rs` 已删除，见下。\n';
    const { counts, missingFiles } = analyzeLedger(ledger, { resolves: NOTHING_RESOLVES, exempt: [] });
    expect(missingFiles).toEqual([]);
    expect(counts.historical).toBe(1);
    expect(counts.checked).toBe(0);
  });

  it('honours an exemption, and counts it separately from the checked set', () => {
    const exempt = [{ path: 'src/git.rs', reason: 'never existed here' }];
    const { counts, missingFiles, staleExemptions } = analyzeLedger('`src/git.rs` 曾被引用', {
      resolves: NOTHING_RESOLVES,
      exempt,
    });
    expect(missingFiles).toEqual([]);
    expect(staleExemptions).toEqual([]);
    expect(counts.exempt).toBe(1);
    expect(counts.checked).toBe(0);
  });

  it('fails an exemption that is no longer cited — the ratchet must not only grow', () => {
    const exempt = [{ path: 'src/git.rs', reason: 'never existed here' }];
    const { counts, staleExemptions } = analyzeLedger('nothing to see here', {
      resolves: NOTHING_RESOLVES,
      exempt,
    });
    expect(staleExemptions.map((s) => s.path)).toEqual(['src/git.rs']);
    expect(counts.staleExemptions).toBe(1);
  });

  it('separates the checked count from the total, so a summary cannot overstate coverage', () => {
    const pad = 'x'.repeat(2100);
    const ledger = [
      'live `src/live.rs`',
      pad,
      'historical **订正** `src/old.rs`',
      pad,
      'upstream `packages/kap-server/src/routes/x.ts`',
    ].join('\n');
    const { counts } = analyzeLedger(ledger, { resolves: (p) => p === 'src/live.rs', exempt: [] });
    expect(counts.citations).toBe(3);
    expect(counts.checked).toBe(1);
    expect(counts.historical).toBe(1);
    expect(counts.upstream).toBe(1);
  });

  it('pins the deliberate cost of the loose window: a live citation beside a retirement note is exempted', () => {
    const ledger = 'live `src/live.rs` then **订正** `src/old.rs`';
    const { counts } = analyzeLedger(ledger, { resolves: () => false, exempt: [] });
    expect(counts.checked).toBe(0);
    expect(counts.historical).toBe(2);
  });
});

describe('findMissingTests', () => {
  const corpus = { fnNames: new Set(['a_tool_note_reaches_the_model_after_the_status']), testNames: new Set() };

  it('reports a cited test name that exists in neither corpus', () => {
    const found = findMissingTests('`test_overflow_recovery_retries_within_its_budget_then_fails`', corpus);
    expect(found.map((f) => f.name)).toEqual(['test_overflow_recovery_retries_within_its_budget_then_fails']);
  });

  it('accepts one that does exist, and ignores names inside a historical block', () => {
    expect(findMissingTests('`a_tool_note_reaches_the_model_after_the_status`', corpus)).toEqual([]);
    const historical = '> **订正**：`a_missing_test_name_that_reports_things` 不存在。';
    expect(findMissingTests(historical, corpus)).toEqual([]);
  });
});

describe('resolvesSomewhere (against this repository)', () => {
  it('resolves a crate-relative path and a repo-relative one', () => {
    expect(resolvesSomewhere('src/tools/mod.rs')).toBe(true);
    expect(resolvesSomewhere('packages/kimi-agent/src/tools/mod.rs')).toBe(true);
  });

  it('does not resolve the deleted watcher', () => {
    expect(resolvesSomewhere('packages/kimi-agent/src/server/fs_watch.rs')).toBe(false);
  });
});

describe('EXEMPT_PATHS', () => {
  it('gives every entry a reason', () => {
    expect(EXEMPT_PATHS.length).toBeGreaterThan(0);
    for (const entry of EXEMPT_PATHS) {
      expect(entry.reason.length, entry.path).toBeGreaterThan(20);
    }
  });

  it('is itself satisfiable: every entry is still cited by the ledger', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'packages/kimi-agent/ROADMAP.md'), 'utf8');
    const { staleExemptions } = analyzeLedger(text, { resolves: () => false });
    expect(staleExemptions).toEqual([]);
  });
});
