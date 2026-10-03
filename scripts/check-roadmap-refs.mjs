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
 * Deliberately NOT checked for citations that claim no coordinate: whether a
 * bare path is the *right* file, and whether a `path:line` citation sits in a
 * "live" sentence. The ≥2000-character historical window below is deliberately
 * loose for the reason the original author gave — this ledger's entries are
 * long prose blocks whose retirement note sits at one end. The old blanket
 * claim that line drift is harmless no longer holds: see the anchor section
 * below, whose 2026-10-04 note explains why and what replaced it.
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
 * What is still NOT checked, on purpose: whether a citation sits in a "live"
 * sentence — see the top of this header for that window's rationale.
 *
 * ── 2026-10-04: the anchor layer — coordinates, for the citations that claim them ──
 *
 * The checks above verify *existence*. They do not verify that the symbol a
 * citation names is what sits at the cited line — and §6.44.5 retired the old
 * "line drift is harmless" stance: when drift crosses a structural boundary the
 * cited line still resolves inside the file but now points at *another
 * function*, and the reader concludes wrongly (live instance: `loopService.ts`
 * `:2117-2119` had drifted onto `emitStepInterrupted`'s parameter list).
 * `scripts/roadmap-citation-anchors.json` now carries, per citation that claims
 * one, the symbol expected at that coordinate; this module verifies it.
 *
 * Four citation shapes proved uncovered by `citedPaths()` during the ledger
 * audits, and the anchor design handles each explicitly:
 *
 *   1. **Crate-relative paths** — `kimi-agent/src/tools/kaos.rs` yields ZERO
 *      regex matches (the pattern requires a `src|packages|apps|scripts|test`
 *      head), so M6's deleted file stayed cited with the gate green. An anchor
 *      carries the resolved path as data; the check does not depend on the
 *      extractor seeing the literal.
 *   2. **Bare basenames** — `forkTurnSlice.ts:86-103`, `microCompactionService.ts`.
 *      A bare basename may match several files, so it is never resolved by
 *      guessing: the anchor's `path` field states the resolved file, and that
 *      resolution is the reviewed artefact.
 *   3. **Upstream-relative sub-paths** — `runtime/runtime.ts:8`,
 *      `human/utils/watch.ts:473` (and `.tmp/` paths): same treatment, resolved
 *      against the named tree rather than the worktree.
 *   4. **Fully-qualified upstream paths were never tested at all.** A cited
 *      `packages/agent-core-v2/...` path is classified `upstream` and
 *      `continue`d *before* `checked++` — even a perfectly well-formed citation
 *      of a deleted module passed. Anchors therefore resolve upstream and
 *      retired trees through **git objects** (`git cat-file -e` /
 *      `git show <ref>:<path>`), never a filesystem probe, and anchor
 *      verification runs *outside* `analyzeLedger` — the upstream
 *      short-circuit cannot skip an anchored citation.
 *
 * Failure semantics (the anchor layer fails on exactly three classes; the
 * fourth is a reporting state, not a finding):
 *
 *   - `citation-drift` — the anchored symbol is not within ±3 lines of the
 *     cited coordinate. Fails, and prints expected vs actual, because a reader
 *     following the pointer lands on the wrong code.
 *   - `stale-anchor` — an anchor whose `cited` literal no longer appears
 *     anywhere in the ledger. Fails: this is a two-way ratchet, the same one
 *     `EXEMPT_PATHS` uses. An anchor that is no longer needed must be dropped
 *     or re-pointed, or the list only grows and eventually "verifies" prose
 *     nobody cites.
 *   - `anchor-missing-target` — the anchor's resolved path does not exist in
 *     its declared tree. Fails (this is the §6.43.2 "cited as upstream, lives
 *     in the retired copy" class).
 *   - An *unavailable ref* (a clone without `upstream/main`, or CI, where this
 *     gate runs BEFORE the workflow's "Fetch upstream" step) is counted as
 *     `unchecked` and reported, never failing: the ref's absence is a property
 *     of the environment, not of the citation. The count is printed so that
 *     blind spot is visible rather than silent.
 *
 * `expect` is a single-line substring taken from the real file; the window is
 * ±3 lines so that trivial line movement inside one symbol does not fail while
 * a move onto a different symbol does. Coverage is printed on every run:
 * anchored vs unanchored, split by whether the extractor can see the shape.
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

/**
 * Trees an anchored citation may resolve in. Upstream is the authoritative
 * reference tree (`.tmp/v2-ref-upstream` is a checkout of it); the retired
 * copy is the deleted packages as they stood at `ecad4136d9`, which is where
 * citations survive that upstream never had (see ROADMAP §6.43.2 — the
 * provenance rule the anchor manifest exists to enforce).
 */
const UPSTREAM_REF = 'upstream/main';
const RETIRED_REF = 'ecad4136d9^';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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

const ANCHORS = join(import.meta.dirname, 'roadmap-citation-anchors.json');

/**
 * How far from the cited line the expected symbol may sit and still count as
 * "the same mechanism". Small on purpose: the failure this layer exists to
 * catch is a citation pointing at *another function*, so a few lines absorb
 * edits inside one symbol while a structural move does not pass.
 */
const ANCHOR_WINDOW = 3;

/**
 * The git object at `<ref>:<path>`, or `undefined` when the ref exists but the
 * path does not, or `null` when the ref itself cannot be resolved.
 *
 * Upstream and retired trees are gone from the worktree on purpose, so a
 * filesystem probe can never verify a citation into them — and a *ref* being
 * absent (a shallow CI clone before the workflow's upstream fetch) is a
 * property of the environment, not of the citation, so it must be reportable
 * separately from a missing path.
 */
export function readGitObject(ref, path, gitRun = git) {
  try {
    gitRun('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    return null;
  }
  try {
    return gitRun('show', `${ref}:${path}`);
  } catch {
    return undefined;
  }
}

/** The worktree text at `path`, or `undefined` when absent. */
export function readWorktreeFile(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Verify the anchor manifest against the ledger text.
 *
 * `readers` is injectable so the test can feed a ledger fragment and a map of
 * contents without building a repository. Each reader returns the text, or
 * `undefined` for "path missing", or `null` for "tree unavailable (unknown
 * ref)" — see `readGitObject`.
 *
 * Pure: given (text, manifest, readers) the result is deterministic.
 */
export function verifyAnchors(text, manifest, readers = defaultAnchorReaders()) {
  const counts = { anchors: manifest.anchors.length, verified: 0, unchecked: 0, drift: 0, stale: 0, missingTarget: 0 };
  const drift = [];
  const staleAnchors = [];
  const missingTargets = [];
  const unchecked = [];

  for (const anchor of manifest.anchors) {
    // An anchor whose citation no longer exists is itself the finding: the
    // manifest must shrink when the prose it pinned does, or it silently grows
    // into "verifying" lines nobody cites.
    if (!text.includes(anchor.cited)) {
      counts.stale++;
      staleAnchors.push({ cited: anchor.cited, note: anchor.note });
      continue;
    }

    const body = readers(anchor);
    if (body === null) {
      counts.unchecked++;
      unchecked.push({ cited: anchor.cited, reason: `${anchor.origin} tree unavailable` });
      continue;
    }
    if (body === undefined) {
      counts.missingTarget++;
      missingTargets.push({ cited: anchor.cited, origin: anchor.origin, path: anchor.path });
      continue;
    }

    const lines = body.split('\n');
    const lo = Math.max(1, anchor.line - ANCHOR_WINDOW);
    const hi = (anchor.endLine ?? anchor.line) + ANCHOR_WINDOW;
    const found = lines.slice(lo - 1, hi).some((l) => l.includes(anchor.expect));
    if (found) {
      counts.verified++;
      continue;
    }

    counts.drift++;
    drift.push({
      cited: anchor.cited,
      origin: anchor.origin,
      path: anchor.path,
      line: anchor.line,
      expect: anchor.expect,
      actual: (lines[anchor.line - 1] ?? '').trim(),
    });
  }

  return { counts, drift, staleAnchors, missingTargets, unchecked };
}

function defaultAnchorReaders() {
  return (anchor) => {
    if (anchor.origin === 'worktree') return readWorktreeFile(join(ROOT, anchor.path));
    if (anchor.origin === 'upstream') return readGitObject(UPSTREAM_REF, anchor.path);
    if (anchor.origin === 'retired') return readGitObject(RETIRED_REF, anchor.path);
    return undefined;
  };
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

function loadAnchors() {
  if (!existsSync(ANCHORS)) {
    console.error(`check-roadmap-refs: ${ANCHORS} not found — the anchor manifest is part of the gate.`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(ANCHORS, 'utf8'));
  const problems = [];
  for (const [i, a] of manifest.anchors.entries()) {
    for (const field of ['cited', 'origin', 'path', 'line', 'expect', 'note']) {
      if (a[field] === undefined || a[field] === '') problems.push(`anchors[${i}] (${a.cited ?? '?'}): missing "${field}"`);
    }
    if (a.origin !== undefined && !['worktree', 'upstream', 'retired'].includes(a.origin)) {
      problems.push(`anchors[${i}] (${a.cited}): origin "${a.origin}" is not worktree|upstream|retired`);
    }
  }
  if (problems.length > 0) {
    console.error(`check-roadmap-refs: roadmap-citation-anchors.json is malformed:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
  return manifest;
}

/**
 * How much of the ledger's line-carrying citation set the manifest covers.
 *
 * The extractor's visible set is the only measurable universe: citations that
 * are invisible to `citedPaths()` AND unanchored cannot be counted at all
 * (nothing sees them), which is exactly why the four blind-spot shapes exist
 * as a reported number rather than a hidden gap. `anchoredVisible` is the part
 * of the manifest the extractor could have found; the remainder is the part
 * only the manifest reaches.
 */
function anchorCoverage(text, manifest, citations) {
  const visible = new Map();
  for (const c of citations) if (c.hasLine) visible.set(`${c.path}:${c.line}`, c);

  let anchoredVisible = 0;
  for (const a of manifest.anchors) {
    const hit = [...visible.values()].some((c) => c.line === a.line && (a.path === c.path || a.path.endsWith(`/${c.path}`)));
    if (hit) anchoredVisible++;
  }
  const anchoredInvisible = manifest.anchors.length - anchoredVisible;
  return {
    anchors: manifest.anchors.length,
    extractorLineCitations: visible.size,
    anchoredVisible,
    anchoredInvisible,
    unanchoredVisible: visible.size - anchoredVisible,
  };
}

function main() {
  if (!existsSync(LEDGER)) {
    console.error('check-roadmap-refs: packages/kimi-agent/ROADMAP.md not found.');
    process.exit(2);
  }
  const text = readFileSync(LEDGER, 'utf8');
  const manifest = loadAnchors();
  const { counts, missingFiles, staleExemptions } = analyzeLedger(text);
  const missingTests = findMissingTests(text, corpus());
  const anchors = verifyAnchors(text, manifest);
  const coverage = anchorCoverage(text, manifest, citedPaths(text));

  const header =
    `check-roadmap-refs: ${counts.citations} file citation(s) (` +
    `${counts.withLine} with a line, ${counts.bare} bare) and ` +
    `${citedTests(text).length} test name(s).`;
  const coverageLine =
    `anchor coverage: ${coverage.anchors} anchored (${coverage.anchoredVisible} the extractor sees, ` +
    `${coverage.anchoredInvisible} of the blind-spot shapes) of ${coverage.extractorLineCitations} line citation(s) ` +
    `the extractor can see; ${coverage.unanchoredVisible} counted, not verified.`;

  const findings =
    missingFiles.length +
    missingTests.length +
    staleExemptions.length +
    anchors.drift.length +
    anchors.staleAnchors.length +
    anchors.missingTargets.length;

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          checked: counts,
          missingFiles,
          missingTests,
          staleExemptions,
          anchors: {
            ...anchors.counts,
            coverage,
            drift: anchors.drift,
            staleAnchors: anchors.staleAnchors,
            missingTargets: anchors.missingTargets,
            uncheckedAnchors: anchors.unchecked,
          },
        },
        null,
        2,
      ),
    );
    process.exit(findings > 0 ? 1 : 0);
  }

  const uncheckedNote =
    anchors.counts.unchecked > 0
      ? ` ${anchors.counts.unchecked} anchor(s) unchecked (ref unavailable).`
      : '';

  if (findings === 0) {
    console.log(
      `${header} ${counts.checked} checked, ${counts.exempt} exempt by EXEMPT_PATHS, ` +
        `${counts.historical} historical, ${counts.upstream} upstream — all resolve. ` +
        `${anchors.counts.verified}/${anchors.counts.anchors} anchored citation(s) verified at their coordinate.${uncheckedNote}\n` +
        `${coverageLine}`,
    );
    process.exit(0);
  }

  console.error(
    `check-roadmap-refs: ${findings} finding(s) ` +
      `(${missingFiles.length} file(s), ${missingTests.length} test name(s), ` +
      `${staleExemptions.length} stale exemption(s), ${anchors.drift.length} coordinate drift(s), ` +
      `${anchors.staleAnchors.length} stale anchor(s), ${anchors.missingTargets.length} missing anchor target(s)).\n`,
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
  for (const d of anchors.drift) {
    console.error(
      `  [citation-drift] \`${d.cited}\` — expected ${JSON.stringify(d.expect)} within ±${ANCHOR_WINDOW} of\n` +
        `      ${d.path}:${d.line} in the ${d.origin} tree, but that line is ${JSON.stringify(d.actual)}\n` +
        `      (fix the anchor's line to the symbol's real position, or fix the ledger if the\n` +
        `      mechanism moved and the prose still claims the old coordinate);`,
    );
  }
  for (const s of anchors.staleAnchors) {
    console.error(
      `  [stale-anchor] \`${s.cited}\` is anchored but no longer cited by the ledger — drop the anchor or\n` +
        `      re-point it (was: ${s.note})`,
    );
  }
  for (const m of anchors.missingTargets) {
    console.error(`  [anchor-missing-target] \`${m.cited}\` resolves to ${m.path}, absent from the ${m.origin} tree — the citation names a file that does not exist there`);
  }
  for (const u of anchors.unchecked) console.error(`  [anchor-unchecked] \`${u.cited}\` — ${u.reason} (not a failure; rerun with the ref fetched)`);
  console.error(
    '\n  A citation that no longer resolves is worse than no citation: a reader auditing\n' +
      '  against the ledger concludes from code that does not exist. Either the ledger is\n' +
      '  stale (fix the path, or mark the entry as historical) or the file is genuinely\n' +
      '  missing (that is a real gap — report it, do not paper over it here).\n' +
      '\n  Add an EXEMPT_PATHS entry only when the path is absent BY DESIGN, and say why\n' +
      '  in the `reason`: the ratchet fails the gate once the entry stops being cited.\n' +
      '\n  For an anchored citation, [citation-drift] means the symbol the anchor names is\n' +
      '  not at the cited line (±3): following the pointer lands on different code.\n' +
      '  Re-verify against the real file and update the anchor, or update the ledger.\n' +
      '  A [missing-file] for a citation you cannot fix is a real gap in the port record.\n' +
      '  For a "measured output" figure with no test behind it, add the test name —\n' +
      '  see ROADMAP §6.17.3.',
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
