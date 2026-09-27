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
const UPSTREAM_PREFIXES = ['packages/agent-core-v2/', 'packages/kap-server/', 'packages/klient/', 'packages/acp-server/'];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** Every `path:line` / `path:line-line` citation in the ledger. */
function citedPaths(text) {
  const out = [];
  // `src/foo.rs:12`, src/foo.rs:12-20, （`src/foo.rs:12`）
  const re = /(?<![\w/])((?:src|packages|apps|scripts|test)\/[\w./-]+\.(?:rs|ts|mjs|tsx|json|yml|nix|md)):(\d+)(?:-(\d+))?/g;
  for (const m of text.matchAll(re)) {
    out.push({ path: m[1], line: Number(m[2]), index: m.index });
  }
  return out;
}

/** Backticked identifiers that look like a Rust test function. */
function citedTests(text) {
  const out = [];
  const re = /`([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)`/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    // A test fn in this codebase is snake_case and reads like a sentence;
    // module paths are matched separately below.
    if (!/^[a-z0-9_]+$/.test(name.split('::').pop() ?? '')) continue;
    if (!/^(test_|a_|an_|the_|.*_is_.*|.*_does_.*|.*_has_.*|.*_keeps_.*|.*_returns_.*|.*_reports_.*|.*_fails_.*|.*_survives_.*|.*_matches_.*|.*_rejects_.*|.*_falls_.*|.*_carries_.*|.*_replays_.*|.*_orders_.*|.*_declines_.*|.*_clamp.*|.*_parse.*|.*_round.*)/.test(name)) continue;
    out.push({ name, index: m.index });
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Where a citation can legitimately resolve from.
 *
 * The ledger writes crate-internal files both ways: `src/mcp/client.rs` when
 * talking about the engine, and `packages/kimi-agent/src/...` when tying a
 * claim to a specific package. Both are real references to the same file, so
 * resolution tries the repo root, the crate root, and `packages/` before
 * calling anything missing — otherwise this gate is ~90% false positives and
 * gets switched off within a day.
 */
const RESOLUTION_ROOTS = [ROOT, CRATE, join(ROOT, 'packages')];

/**
 * Markers the ledger uses to retire a claim in place. A citation sitting inside
 * such a block is *supposed* to name something that no longer exists — that is
 * the whole point of the correction — so quoting it must not be reported.
 */
const HISTORICAL_MARKERS = ['订正', '已作废', '撤销前', '撤销前的历史记录', '仅存历史价值', '不代表现存代码', '重写为', '改名为', '已退役'];

function isInsideHistoricalBlock(text, index) {
  // Symmetric window: a retirement note is as likely to sit *after* the
  // citation it retires ("重写为 X"、"（旧 `foo` 钉的就是这个形状）") as before it.
  // The window is wide because this ledger's entries are long prose blocks —
  // a single item (e.g. the reverted v3 protocol) runs for a hundred-plus lines,
  // and its retirement note sits at one end of the block rather than next to
  // every citation inside it.
  const WINDOW = 2000;
  const around = text.slice(Math.max(0, index - WINDOW), index + WINDOW);
  // Deliberately loose. The cost is that a live citation placed near a
  // retirement note goes unreported; the benefit is that the gate never fires
  // on a correction that is quoting the very thing it corrects. For a gate
  // people must not learn to ignore, that trade is the right way round.
  return HISTORICAL_MARKERS.some((m) => around.includes(m));
}

function resolvesSomewhere(p) {
  if (RESOLUTION_ROOTS.some((base) => existsSync(join(base, p)))) return true;
  // Path abbreviation: the ledger writes `src/contract/schema.ts` for what is
  // really `packages/transcript/src/contract/schema.ts`. Accept it when exactly
  // one package-relative file ends with that path, so a genuinely deleted file
  // is still reported.
  const suffix = `/${p}`;
  let matches = 0;
  for (const pkg of ['packages', 'apps']) {
    const base = join(ROOT, pkg);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(base, entry.name, p))) matches++;
    }
  }
  void suffix;
  return matches === 1;
}

function main() {
  if (!existsSync(LEDGER)) {
    console.error('check-roadmap-refs: packages/kimi-agent/ROADMAP.md not found.');
    process.exit(2);
  }
  const text = readFileSync(LEDGER, 'utf8');

  const problems = [];

  // ── 1. Cited files that do not exist ──────────────────────────────────────
  const missingPaths = new Map();
  for (const { path, index } of citedPaths(text)) {
    if (UPSTREAM_PREFIXES.some((p) => path.startsWith(p))) continue; // v2 reference
    // A retired block may legitimately cite a file that the retirement deleted
    // — that is how the reader learns the file used to exist.
    if (isInsideHistoricalBlock(text, index)) continue;
    if (resolvesSomewhere(path)) continue;
    const key = path;
    if (!missingPaths.has(key)) missingPaths.set(key, []);
    missingPaths.get(key).push(lineOf(text, index));
  }
  for (const [path, sites] of [...missingPaths].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    // `sites` holds LEDGER line numbers (not the cited file's line number) —
    // reporting the latter sends the reader to the wrong place entirely.
    const shown = [...new Set(sites)].slice(0, 5).join(', ');
    const more = sites.length > 5 ? ` (+${sites.length - 5} more)` : '';
    problems.push({
      kind: 'missing-file',
      detail: `${path} — cited at ledger line(s) ${shown}${more}`,
    });
  }

  // ── 2. Cited test functions that do not exist ─────────────────────────────
  let rustCorpus = '';
  try {
    rustCorpus = git('grep', '-h', '-E', '(#\\[(tokio::)?test\\]|fn )', '--', 'packages/kimi-agent/src', 'packages/kimi-agent/tests');
  } catch {
    // git grep exits 1 when nothing matches; fall back to an empty corpus so
    // the test check reports "unknown" rather than pretending to pass.
    rustCorpus = '';
  }
  const rustFnNames = new Set();
  for (const m of rustCorpus.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) rustFnNames.add(m[1]);
  const tsTestNames = new Set();
  try {
    const ts = git('grep', '-h', '-E', '(it|test|describe)\\s*\\(', '--', 'packages/kimi-agent', 'packages/node-sdk');
    for (const m of ts.matchAll(/(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g)) tsTestNames.add(m[1]);
  } catch {
    /* no TS tests matched */
  }

  const missingTests = new Map();
  for (const { name, index } of citedTests(text)) {
    if (isInsideHistoricalBlock(text, index)) continue;
    const bare = name.split('::').pop();
    if (rustFnNames.has(bare) || tsTestNames.has(bare)) continue;
    if (!missingTests.has(bare)) missingTests.set(bare, lineOf(text, index));
  }
  for (const [name, line] of [...missingTests].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    problems.push({
      kind: 'missing-test',
      detail: `${name} — cited at ledger line ${line}`,
    });
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked: { citations: citedPaths(text).length, testNames: citedTests(text).length }, problems }, null, 2));
    process.exit(problems.length > 0 ? 1 : 0);
  }

  const citations = citedPaths(text).length;
  const testNames = citedTests(text).length;
  if (problems.length === 0) {
    console.log(
      `check-roadmap-refs: ${citations} file citation(s) and ${testNames} test name(s) in the ledger all resolve.`,
    );
    process.exit(0);
  }

  const files = problems.filter((p) => p.kind === 'missing-file');
  const tests = problems.filter((p) => p.kind === 'missing-test');
  console.error(
    `check-roadmap-refs: ${problems.length} ledger citation(s) no longer resolve ` +
      `(${files.length} file(s), ${tests.length} test name(s)).\n`,
  );
  for (const p of files) console.error(`  [missing-file] ${p.detail}`);
  for (const p of tests) console.error(`  [missing-test] ${p.detail}`);
  console.error(
    '\n  A citation that no longer resolves is worse than no citation: a reader auditing\n' +
      '  against the ledger concludes from code that does not exist. Either the ledger is\n' +
      '  stale (mark the entry as historical, or delete it) or the file is genuinely\n' +
      '  missing (that is a real gap — report it, do not paper over it here).\n' +
      '\n  Line-number drift is intentionally NOT reported; see the header for why.\n' +
      '  For a "measured output" figure with no test behind it, add the test name —\n' +
      '  see ROADMAP §6.17.3.',
  );
  process.exit(1);
}

main();
