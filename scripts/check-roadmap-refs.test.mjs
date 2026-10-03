import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXEMPT_PATHS,
  analyzeLedger,
  anchorSites,
  citedPaths,
  findMissingTests,
  readGitObject,
  readWorktreeFile,
  resolvesSomewhere,
  verifyAnchors,
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

/**
 * The anchor layer. Readers are injected, so these cases describe the
 * mechanism rather than this repository's current file list.
 */
const readerFor = (contents) => (anchor) => contents[`${anchor.origin}:${anchor.path}`];

const anchor = (over = {}) => ({
  cited: 'thing.rs:10',
  origin: 'worktree',
  path: 'pkgs/thing/src/thing.rs',
  line: 10,
  context: 'prose citing `',
  expect: 'fn do_the_thing(',
  note: 'test anchor',
  ...over,
});

describe('verifyAnchors', () => {
  const body = (lines) => lines.join('\n');

  it('verifies an anchor whose symbol is at the cited coordinate — green', () => {
    const text = 'prose citing `thing.rs:10` here';
    const contents = { 'worktree:pkgs/thing/src/thing.rs': body([...Array(9).fill('// filler'), 'fn do_the_thing() {}']) };
    const r = verifyAnchors(text, { anchors: [anchor()] }, readerFor(contents));
    expect(r.counts).toMatchObject({ anchors: 1, verified: 1, drift: 0, stale: 0, missingTarget: 0 });
    expect(r.drift).toEqual([]);
  });

  it('fails when the line drifted onto another symbol, naming expected and actual', () => {
    // The §6.44.5 failure shape: the number still resolves inside the file,
    // but now points at a different function.
    const text = 'prose citing `thing.rs:10` here';
    const lines = [...Array(20).fill('// filler')];
    lines[9] = 'fn do_the_other_thing(';
    const contents = { 'worktree:pkgs/thing/src/thing.rs': body(lines) };
    const r = verifyAnchors(text, { anchors: [anchor()] }, readerFor(contents));
    expect(r.counts.drift).toBe(1);
    expect(r.drift[0]).toMatchObject({
      cited: 'thing.rs:10',
      expect: 'fn do_the_thing(',
      actual: 'fn do_the_other_thing(',
    });
  });

  it('tolerates drift within one symbol (±3) but not a structural move', () => {
    const text = 'prose citing `thing.rs:10` here';
    const near = [...Array(20).fill('// filler')];
    near[12] = 'fn do_the_thing() {}';
    expect(verifyAnchors(text, { anchors: [anchor()] }, readerFor({ 'worktree:pkgs/thing/src/thing.rs': body(near) })).counts.verified).toBe(1);

    const far = [...Array(20).fill('// filler')];
    far[5] = 'fn do_the_thing() {}';
    expect(verifyAnchors(text, { anchors: [anchor()] }, readerFor({ 'worktree:pkgs/thing/src/thing.rs': body(far) })).counts.drift).toBe(1);
  });

  it('fails an anchor whose target is absent from its declared tree', () => {
    const r = verifyAnchors('prose citing `thing.rs:10`', { anchors: [anchor()] }, readerFor({}));
    expect(r.counts.missingTarget).toBe(1);
    expect(r.missingTargets[0]).toMatchObject({ origin: 'worktree', path: 'pkgs/thing/src/thing.rs' });
  });

  it('never fails on an unavailable tree — it counts the anchor as unchecked instead', () => {
    const r = verifyAnchors('prose citing `thing.rs:10`', { anchors: [anchor()] }, () => null);
    expect(r.counts).toMatchObject({ unchecked: 1, verified: 0, missingTarget: 0, drift: 0 });
    expect(r.unchecked[0].reason).toContain('unavailable');
  });

  it('fails an anchor the ledger no longer cites — the manifest must not only grow', () => {
    const r = verifyAnchors('the prose dropped the pointer', { anchors: [anchor()] }, () => 'fn do_the_thing() {}');
    expect(r.counts.stale).toBe(1);
    expect(r.staleAnchors[0]).toMatchObject({ cited: 'thing.rs:10' });
  });

  it('goes stale when the literal survives elsewhere but its own citation site is gone', () => {
    // The reviewer's simulation of the real ledger: `:1876` appears on three
    // lines, so a bare `text.includes()` test kept the anchor "live" after the
    // §2.5 row lost the pointer. Site-pinning must catch that.
    const text = ['row one cites `:1876` and says stopRequested', 'row two cites `:1876` inside a later note'].join('\n');
    const a = anchor({ cited: ':1876', context: 'and says stopRequested' });
    const body = [...Array(9).fill('// filler'), 'fn do_the_thing() {}'].join('\n');
    expect(verifyAnchors(text, { anchors: [a] }, () => body).counts.verified).toBe(1);

    const mutated = text.replace('cites `:1876` and says stopRequested', 'cites `:9999` and says stopRequested');
    expect(mutated.includes(':1876')).toBe(true);
    const r = verifyAnchors(mutated, { anchors: [a] }, () => body);
    expect(r.counts.stale).toBe(1);
    expect(r.staleAnchors[0]).toMatchObject({ cited: ':1876', occurrences: [2] });
  });

  it('fails an anchor whose context does not pick a single site — the same hole, under-specified', () => {
    const text = ['first `thing.rs:10` one', 'second `thing.rs:10` one'].join('\n');
    const a = anchor({ context: '`thing.rs:10` one' });
    const r = verifyAnchors(text, { anchors: [a] }, () => 'fn do_the_thing() {}');
    expect(r.counts).toMatchObject({ ambiguous: 1, verified: 0, stale: 0 });
    expect(r.ambiguousAnchors[0]).toMatchObject({ cited: 'thing.rs:10', sites: [1, 2] });
  });

  it('counts an unanchored citation without failing it — the extractor sees it, the manifest does not claim it', () => {
    const text = 'cite `src/other.rs:5` which has no anchor';
    expect(citedPaths(text)).toHaveLength(1);
    const r = verifyAnchors(text, { anchors: [anchor()] }, () => undefined);
    expect(r.counts.stale).toBe(1);
    expect(r.counts.missingTarget).toBe(0);
  });

  it('verifies each of the four blind-spot shapes the extractor cannot see', () => {
    const text = [
      'crate-relative `kimi-agent/src/tools/kaos.rs`',
      'bare basename `forkTurnSlice.ts:86-103`',
      'upstream sub-path `runtime/runtime.ts:8`',
      'fully-qualified upstream `packages/agent-core-v2/src/agent/gone/gone.ts:3`',
    ].join('\n');
    const anchors = [
      anchor({ cited: 'kimi-agent/src/tools/kaos.rs', origin: 'worktree', path: 'packages/kimi-agent/src/tools/kaos.rs', line: 1, context: 'crate-relative `', expect: 'mod kaos;' }),
      anchor({ cited: 'forkTurnSlice.ts:86-103', origin: 'upstream', path: 'packages/agent-core-v2/src/workspace/forkTurnSlice.ts', line: 86, endLine: 103, context: 'bare basename `', expect: 'function isUserVisibleTurnRecord(' }),
      anchor({ cited: 'runtime/runtime.ts:8', origin: 'upstream', path: 'packages/agent-core-v2/src/runtime/runtime.ts', line: 8, context: 'upstream sub-path `', expect: 'export type RuntimeCapability' }),
      anchor({ cited: 'packages/agent-core-v2/src/agent/gone/gone.ts:3', origin: 'upstream', path: 'packages/agent-core-v2/src/agent/gone/gone.ts', line: 3, context: 'fully-qualified upstream `', expect: 'anything' }),
    ];
    // The extractor sees only the fully-qualified shape (1 of 4); the first
    // three are invisible by construction, and the visible one is never
    // existence-tested because `analyzeLedger` classifies it `upstream` and
    // `continue`s before `checked++` — which is exactly why the anchor layer
    // must ask the git object instead.
    const seen = citedPaths(text);
    expect(seen.map((c) => c.path)).toEqual(['packages/agent-core-v2/src/agent/gone/gone.ts']);
    const { counts } = analyzeLedger(text, { resolves: () => false, exempt: [] });
    expect(counts.upstream).toBe(1);
    expect(counts.checked).toBe(0);
    const contents = {
      'worktree:packages/kimi-agent/src/tools/kaos.rs': 'mod kaos;\n',
      'upstream:packages/agent-core-v2/src/workspace/forkTurnSlice.ts': [...Array(85).fill('// x'), 'function isUserVisibleTurnRecord(record: WireRecord): boolean {'].join('\n'),
      'upstream:packages/agent-core-v2/src/runtime/runtime.ts': [...Array(7).fill('// x'), 'export type RuntimeCapability = ...'].join('\n'),
      'upstream:packages/agent-core-v2/src/agent/gone/gone.ts': undefined,
    };
    const r = verifyAnchors(text, { anchors }, readerFor(contents));
    expect(r.counts).toMatchObject({ anchors: 4, verified: 3, missingTarget: 1, drift: 0, stale: 0 });
  });

  it('resolves git objects, distinguishing an unavailable ref (null) from a missing path (undefined)', () => {
    // A ref that cannot be resolved: `rev-parse` throws.
    const noRef = () => {
      throw new Error('unknown ref');
    };
    expect(readGitObject('upstream/main', 'x', noRef)).toBeNull();
    // A ref that resolves but has no such path: `show` throws.
    const refOnly = (cmd) => {
      if (cmd === 'rev-parse') return 'abc123';
      throw new Error('path not in tree');
    };
    expect(readGitObject('upstream/main', 'gone', refOnly)).toBeUndefined();
    expect(readGitObject('upstream/main', 'here', (cmd) => (cmd === 'rev-parse' ? 'abc' : 'body'))).toBe('body');
  });

  it('reads the worktree through the filesystem, absent files as undefined', () => {
    expect(readWorktreeFile(join(import.meta.dirname, 'check-roadmap-refs.mjs'))).toContain('verifyAnchors');
    expect(readWorktreeFile(join(import.meta.dirname, 'no-such-file-here.mjs'))).toBeUndefined();
  });
});

describe('the shipped manifest', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'roadmap-citation-anchors.json'), 'utf8'));

  it('gives every anchor the fields the validator requires, and a note saying why', () => {
    expect(manifest.anchors.length).toBeGreaterThan(0);
    expect(manifest.anchors.length).toBeLessThanOrEqual(25);
    for (const a of manifest.anchors) {
      for (const field of ['cited', 'origin', 'path', 'line', 'context', 'expect', 'note']) {
        expect(a[field], `${a.cited} is missing ${field}`).toBeDefined();
      }
      expect(['worktree', 'upstream', 'retired'], a.cited).toContain(a.origin);
      expect(a.note.length, a.cited).toBeGreaterThan(20);
    }
  });

  it('pins every anchor to exactly one ledger site, so the ratchet cannot be defeated by a repeated literal', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'packages/kimi-agent/ROADMAP.md'), 'utf8');
    for (const a of manifest.anchors) {
      const { sites, occurrences } = anchorSites(text, a);
      expect(sites, `${a.cited} must match exactly one site (context ${JSON.stringify(a.context)})`).toHaveLength(1);
      expect(occurrences.length, a.cited).toBeGreaterThanOrEqual(sites.length);
    }
    // The condition this protects against really is live in the ledger.
    const repeated = manifest.anchors.filter((a) => anchorSites(text, a).occurrences.length > 1);
    expect(repeated.length, 'anchors whose literal occurs more than once').toBeGreaterThan(0);
  });

  it('is satisfied by the real ledger and the real trees', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'packages/kimi-agent/ROADMAP.md'), 'utf8');
    const { counts, drift, staleAnchors, ambiguousAnchors, missingTargets } = verifyAnchors(text, manifest);
    expect({ drift, staleAnchors, ambiguousAnchors, missingTargets }).toEqual({
      drift: [],
      staleAnchors: [],
      ambiguousAnchors: [],
      missingTargets: [],
    });
    expect(counts.verified + counts.unchecked).toBe(manifest.anchors.length);
  });
});
