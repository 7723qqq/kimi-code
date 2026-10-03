#!/usr/bin/env bun
/**
 * Ratchet gate for this fork's own divergence ledger.
 *
 * `packages/kimi-agent/ROADMAP.md` is the hand-maintained record of what the
 * Rust engine port did and did not take from the deleted TypeScript engine. A
 * 34-claim spot check (2026-09-27) found it trustworthy — 30 of 34 exactly
 * right, several with line-accurate citations — but it fails in one systematic
 * way (recorded in ROADMAP §6.17.2): the *existence* of cited evidence is
 * re-verified constantly, while its *coordinates* and *attribution* never are.
 *
 * Two concrete symptoms that this gate catches, because both were live in the
 * ledger on 2026-09-27:
 *
 *   1. Citations to files that no longer exist. `86f30ecc2c` reverted the v3
 *      flat-entity protocol, deleting `src/server/v3/**` and
 *      `src/server/ws_v3.rs`, yet §6.1-4 / §6.2 / §7.3 / §10.21 still cite
 *      them as if present, and §6.2's decision at the old `ws_v3.rs:29` rests
 *      on a file that is gone.
 *   2. Citations to test functions that do not exist. §10.18 cited
 *      `test_overflow_recovery_retries_within_its_budget_then_fails`; it is
 *      absent from the working tree AND from all of git history, and the
 *      "measured output" quoted beside it was never asserted by any test.
 *
 * Deliberately NOT checked: whether a cited line number still holds the cited
 * symbol. Line drift is pervasive and harmless — a drifted line number costs a
 * reader one grep, while a missing file or a phantom test costs them a wrong
 * conclusion. Flagging every drifted line would bury the two failures that
 * matter under hundreds of warnings, which is how a gate gets ignored.
 *
 * ── 2026-10-03: two holes closed after a ledger audit ────────────────────
 *
 * The audit measured this gate's coverage instead of trusting its summary line,
 * and found the coverage far narrower than "N file citation(s) ... all resolve"
 * suggests:
 *
 *   3. Only `path:line` citations were extracted. The ledger's BARE paths —
 *      235 of them, more than the 90 that carry a line — never reached the
 *      checker. `packages/kimi-agent/src/server/fs_watch.rs` sat in §6.1
 *      asserting a tokio polling watcher for a file deleted weeks earlier, and
 *      contradicted §6.1-32 four hundred lines below, silently.
 *   4. The summary counted citations that had been *exempted*, so "90 resolve"
 *      described 56 checked. It now prints the split.
 *
 * Both are fixed. The price of checking bare paths is that the legitimate
 * reasons to name a path with no local file must now be explicit rather than
 * inferred:
 *
 *   - `UPSTREAM_RELATIVE_ROOTS` — upstream trees cited without their package
 *     prefix (`test/agent/…` means `agent-core-v2/test/agent/…`).
 *   - `EXEMPT_PATHS` — a specific path that is absent by design, each entry
 *     carrying a `reason`. Two-way ratchet: an entry that stops being cited is
 *     reported as `stale-exemption`, so the list cannot rot.
 *
 * What is still NOT checked, on purpose: line drift, and whether a citation
 * sits in a "live" sentence. The ≥2000-character historical window below is
 * deliberately loose for the reason the original author gave — this ledger's
 * entries are long prose blocks whose retirement note sits at one end.
 *
 * Usage:
 *   bun scripts/check-roadmap-refs.mjs          # check (exit 1 on findings)
 *   bun scripts/check-roadmap-refs.mjs --json   # machine-readable
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LEDGER = join(ROOT, 'packages/kimi-agent/ROADMAP.md');
const CRATE = join(ROOT, 'packages/kimi-agent');

/** Repo-relative prefixes a citation may point into. */
/** Upstream-only trees: a citation into these is a v2 reference, not a local file. */
const UPSTREAM_PREFIXES = [
  'packages/agent-core-v2/',
  'packages/kap-server/',
  'packages/klient/',
  'packages/acp-server/',
];

/**
 * Upstream trees the ledger cites WITHOUT their package prefix.
 *
 * The ledger's "上游测试规格映射" tables name upstream specs relative to the
 * package root (`test/agent/agentsMdReminder/agentsMdReminder.test.ts` is
 * `packages/agent-core-v2/test/…`). Those trees are deleted in this fork, so no
 * amount of local resolution can find them; treating `test/` as upstream is
 * what keeps the four such citations from being reported as dead local files.
 * The fork keeps its own tests inside each package's `test/` directory, never at
 * the repository root.
 */
export const UPSTREAM_RELATIVE_ROOTS = ['test/'];

/**
 * Paths the ledger may legitimately cite although no local file exists there.
 * Every entry states why; the check is a two-way ratchet (an entry that is no
 * longer cited anywhere fails the gate as `stale-exemption`).
 */
export const EXEMPT_PATHS = [
  {
    path: 'packages/kimi-agent/src/server/fs_watch.rs',
    reason:
      'deleted in adc794635c (§7.3); §6.1-20 and §6.1-32 cite it to record that the engine has no watcher at all',
  },
  {
    path: 'packages/protocol/src/v3.ts',
    reason: 'deleted in 86f30ecc2c when the v3 flat-entity protocol was reverted (§8.11)',
  },
  {
    path: 'src/git.rs',
    reason:
      'never existed in this repository (no add, delete or touch in any commit); cited by §6.40 and §11 as the phantom path an older record named',
  },
  {
    path: 'packages/kimi-agent/src/git.rs',
    reason:
      'the crate-relative src/git.rs written the long way (same never-existed file); §11.10 cites it inside the repro command',
  },
  {
    path: 'src/protocol/rest-terminal.ts',
    reason:
      'upstream kap-server file cited in abbreviated form; the package it lives in is deleted, so nothing local can ever resolve',
  },
];

/** Markers the ledger uses to retire a claim in place. */
const HISTORICAL_MARKERS = [
  '订正',
  '已作废',
  '撤销前',
  '撤销前的历史记录',
  '仅存历史价值',
  '不代表现存代码',
  '重写为',
  '改名为',
  '已退役',
];

const RESOLUTION_ROOTS = [ROOT, CRATE, join(ROOT, 'packages')];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/**
 * Every `path:line` / `path:line-line` citation in the ledger, plus every bare
 * path. The line suffix is optional here: requiring it is what let 235 bare
 * citations go unchecked (see the 2026-10-03 note above).
 */
export function citedPaths(text) {
  const out = [];
  const re =
    /(?<![\w/])((?:src|packages|apps|scripts|test)\/[\w./-]+\.(?:rs|ts|mjs|tsx|json|yml|nix|md))(?!\w)(?::(\d+)(?:-(\d+))?)?/g;
  for (const m of text.matchAll(re)) {
    out.push({ path: m[1], line: m[2] === undefined ? undefined : Number(m[2]), hasLine: m[2] !== undefined, index: m.index });
  }
  return out;
}

/** Backticked identifiers that look like a Rust test function. */
export function citedTests(text) {
  const out = [];
  const re = /`([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)`/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (!/^[a-z0-9_]+$/.test(name.split('::').pop() ?? '')) continue;
    if (
      !/^(test_|a_|an_|the_|.*_is_.*|.*_does_.*|.*_has_.*|.*_keeps_.*|.*_returns_.*|.*_reports_.*|.*_fails_.*|.*_survives_.*|.*_matches_.*|.*_rejects_.*|.*_falls_.*|.*_carries_.*|.*_replays_.*|.*_orders_.*|.*_declines_.*|.*_clamp.*|.*_parse.*|.*_round.*)/.test(
        name,
      )
    )
      continue;
    out.push({ name, index: m.index });
  }
  return out;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function isUpstreamPath(p) {
  return (
    UPSTREAM_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
    UPSTREAM_RELATIVE_ROOTS.some((root) => p.startsWith(root))
  );
}

/**
 * Markers the ledger uses to retire a claim in place. A citation sitting inside
 * such a block is *supposed* to name something that no longer exists — that is
 * the whole point of the correction — so quoting it must not be reported.
 */
export function isInsideHistoricalBlock(text, index) {
  const WINDOW = 2000;
  const around = text.slice(Math.max(0, index - WINDOW), index + WINDOW);
  return HISTORICAL_MARKERS.some((m) => around.includes(m));
}

export function resolvesSomewhere(p) {
  if (RESOLUTION_ROOTS.some((base) => existsSync(join(base, p)))) return true;
  // Path abbreviation: the ledger writes `src/contract/schema.ts` for what is
  // really `packages/transcript/src/contract/schema.ts`. Accept it when exactly
  // one package-relative file ends with that path, so a genuinely deleted file
  // is still reported.
  let matches = 0;
  for (const pkg of ['packages', 'apps']) {
    const base = join(ROOT, pkg);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(base, entry.name, p))) matches++;
    }
  }
  return matches === 1;
}

/**
 * The whole file check, as a pure function of the ledger text.
 *
 * `resolves` is injectable so a test can exercise the classification without
 * building a filesystem that reproduces this repository.
 */
export function analyzeLedger(text, { exempt = EXEMPT_PATHS, resolves = resolvesSomewhere } = {}) {
  const citations = citedPaths(text);
  const byPath = new Map(exempt.map((entry) => [entry.path, entry]));
  const usedExempt = new Set();

  const counts = {
    citations: citations.length,
    withLine: 0,
    bare: 0,
    upstream: 0,
    historical: 0,
    exempt: 0,
    checked: 0,
    missing: 0,
    staleExemptions: 0,
  };
  const missingFiles = new Map();

  for (const c of citations) {
    if (c.hasLine) counts.withLine++;
    else counts.bare++;
    if (isUpstreamPath(c.path)) {
      counts.upstream++;
      continue;
    }
    if (byPath.has(c.path)) {
      counts.exempt++;
      usedExempt.add(c.path);
      continue;
    }
    if (isInsideHistoricalBlock(text, c.index)) {
      counts.historical++;
      continue;
    }
    counts.checked++;
    if (resolves(c.path)) continue;
    counts.missing++;
    if (!missingFiles.has(c.path)) missingFiles.set(c.path, []);
    missingFiles.get(c.path).push(lineOf(text, c.index));
  }

  // Two-way ratchet: an exemption nobody needs any more is itself a failure,
  // otherwise the list only ever grows and eventually exempts the real thing.
  const staleExemptions = [];
  for (const entry of exempt) {
    if (usedExempt.has(entry.path)) continue;
    counts.staleExemptions++;
    staleExemptions.push({ path: entry.path, reason: entry.reason });
  }

  return {
    counts,
    missingFiles: [...missingFiles]
      .map(([path, lines]) => ({ path, lines: [...new Set(lines)] }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    staleExemptions,
  };
}

/** Cited test names that appear in neither corpus. Pure, so the test can feed a corpus. */
export function findMissingTests(text, { fnNames, testNames }) {
  const missing = new Map();
  for (const { name, index } of citedTests(text)) {
    if (isInsideHistoricalBlock(text, index)) continue;
    const bare = name.split('::').pop();
    if (fnNames.has(bare) || testNames.has(bare)) continue;
    if (!missing.has(bare)) missing.set(bare, lineOf(text, index));
  }
  return [...missing].map(([name, line]) => ({ name, line })).toSorted((a, b) => (a.name < b.name ? -1 : 1));
}

function corpus() {
  let rustCorpus = '';
  try {
    rustCorpus = git('grep', '-h', '-E', '(#\\[(tokio::)?test\\]|fn )', '--', 'packages/kimi-agent/src', 'packages/kimi-agent/tests');
  } catch {
    rustCorpus = '';
  }
  const fnNames = new Set();
  for (const m of rustCorpus.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) fnNames.add(m[1]);

  const testNames = new Set();
  try {
    const ts = git('grep', '-h', '-E', '(it|test|describe)\\s*\\(', '--', 'packages/kimi-agent', 'packages/node-sdk');
    for (const m of ts.matchAll(/(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g)) testNames.add(m[1]);
  } catch {
    /* no TS tests matched */
  }
  return { fnNames, testNames };
}

function main() {
  if (!existsSync(LEDGER)) {
    console.error('check-roadmap-refs: packages/kimi-agent/ROADMAP.md not found.');
    process.exit(2);
  }
  const text = readFileSync(LEDGER, 'utf8');
  const { counts, missingFiles, staleExemptions } = analyzeLedger(text);
  const missingTests = findMissingTests(text, corpus());

  const header =
    `check-roadmap-refs: ${counts.citations} file citation(s) (` +
    `${counts.withLine} with a line, ${counts.bare} bare) and ` +
    `${citedTests(text).length} test name(s).`;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked: counts, missingFiles, missingTests, staleExemptions }, null, 2));
    process.exit(missingFiles.length + missingTests.length + staleExemptions.length > 0 ? 1 : 0);
  }

  const findings = missingFiles.length + missingTests.length + staleExemptions.length;
  if (findings === 0) {
    console.log(
      `${header} ${counts.checked} checked, ${counts.exempt} exempt by EXEMPT_PATHS, ` +
        `${counts.historical} historical, ${counts.upstream} upstream — all resolve.`,
    );
    process.exit(0);
  }

  console.error(
    `check-roadmap-refs: ${findings} ledger citation(s) no longer resolve ` +
      `(${missingFiles.length} file(s), ${missingTests.length} test name(s), ` +
      `${staleExemptions.length} stale exemption(s)).\n`,
  );
  for (const { path, lines } of missingFiles) {
    const shown = lines.slice(0, 5).join(', ');
    const more = lines.length > 5 ? ` (+${lines.length - 5} more)` : '';
    console.error(`  [missing-file] ${path} — cited at ledger line(s) ${shown}${more}`);
  }
  for (const { name, line } of missingTests) console.error(`  [missing-test] ${name} — cited at ledger line ${line}`);
  for (const { path, reason } of staleExemptions) {
    console.error(`  [stale-exemption] ${path} is exempted but no longer cited — drop it (was: ${reason})`);
  }
  console.error(
    '\n  A citation that no longer resolves is worse than no citation: a reader auditing\n' +
      '  against the ledger concludes from code that does not exist. Either the ledger is\n' +
      '  stale (fix the path, or mark the entry as historical) or the file is genuinely\n' +
      '  missing (that is a real gap — report it, do not paper over it here).\n' +
      '\n  Add an EXEMPT_PATHS entry only when the path is absent BY DESIGN, and say why\n' +
      '  in the `reason`: the ratchet fails the gate once the entry stops being cited.\n' +
      '\n  Line-number drift is intentionally NOT reported; see the header for why.\n' +
      '  For a "measured output" figure with no test behind it, add the test name —\n' +
      '  see ROADMAP §6.17.3.',
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
