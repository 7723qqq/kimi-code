#!/usr/bin/env bun
/**
 * check-rust-module-deps.mjs — the engine's intra-crate module dependency graph, as a ratchet.
 *
 * Why this gate exists
 * --------------------
 * `packages/kimi-agent` is a single Rust crate of ~250 source files whose internal
 * module graph is not modelled anywhere else in this repository. Three artifacts
 * could plausibly have covered it, and measured 2026-10-04 none did:
 *
 *   - `architecture.json` — 17 modules / 30 declared package edges. Exactly one
 *     module covers the engine (`kimi-agent`), and its `deps` is `[]` on purpose.
 *     Its Check B (`scripts/check-architecture-drift.mjs`) reads import statements
 *     in `IMPORT_EXTENSIONS` (`:53`), which lists `.ts .tsx .js .jsx .mjs .cjs
 *     .mts .vue` and **not `.rs`** — and `packages/kimi-agent/package.json` has no
 *     `dependencies` at all, so Check B has nothing to compare against. Coverage
 *     of the engine's intra-crate graph: **0 edges**.
 *   - `normify-kimi-code/tree.json` — 74 modules / 29 edges, of which 37 are
 *     `kimi-code.engine.*` and 15 are engine-internal (e.g. `engine.core ->
 *     engine.llm`, `engine.core.turn-loop -> engine.tools`). Real coverage, but at
 *     *concept* granularity: 15 conceptual edges against 248 real ones, and the
 *     engine's top-level library modules are not represented as modules there at all.
 *   - the real `crate::` graph — 248 directed pairs over 38 library modules,
 *     extracted from the 250 `.rs` files under `packages/kimi-agent/src`. This is
 *     the graph this gate records.
 *
 * So the honest statement is not "the engine has zero coverage"; it is that the
 * engine's dense intra-crate graph has no mechanical owner, and the one artifact
 * that does model part of it (normify) is a hand-drawn diagram at a coarser
 * granularity. A new `use crate::foo` edge between two engine modules currently
 * lands with no reviewer-visible signal at all.
 *
 * What it models (and what it does not)
 * -------------------------------------
 * An edge is `from -> to` where both are *top-level modules*: the first path
 * segment under `packages/kimi-agent/src` — a directory name (`tools/…` -> `tools`)
 * or a file stem (`callbacks.rs` -> `callbacks`). Three spellings count:
 *
 *   use crate::tools::foo::Bar;          // single-path use statement
 *   use crate::{tools, rpc::types};      // grouped use; nested groups resolve to
 *                                        // their top segment (`tools`, `rpc`)
 *   let x = crate::tools::bar();         // inline path in expression/type position
 *
 * Inline paths are included because `use` statements alone miss 112 of the 248
 * pairs — a function in `callbacks` calling `crate::session::foo()` is a real
 * dependency that no `use` line states.
 *
 * Deliberately excluded:
 *   - comments (line, doc and block) and string / raw-string literals, so a doc
 *     example or an error message mentioning `crate::x` cannot invent an edge;
 *   - `tests/**` and `build.rs`. The integration tests bind the library as an
 *     *external* crate (`kimi_agent::…`, 34 sites naming 10 modules), which
 *     `crate::` cannot express; the external-consumer -> library axis is a
 *     different graph and is not modelled here.
 *
 * `src/main.rs` stays in the walk and contributes no edges today: it is the CLI
 * binary's entry point and reaches the library through `kimi_agent::…` (67 sites,
 * 14 modules) rather than `crate::`, so it is a consumer of the graph below
 * rather than a node in it. It is left in rather than filtered so that a future
 * `crate::` reference from it is recorded instead of silently dropped.
 *
 * Test code (`#[cfg(test)] mod tests`) *is* included: a test reaching into another
 * module's internals is the same coupling, and excluding it would make half the
 * graph invisible. The cost is that test churn can move an edge, in which case the
 * ratchet asks for one baseline line rather than failing silently.
 *
 * Why this is not folded into `architecture.json`
 * ----------------------------------------------
 * Different granularity and different axis. `architecture.json` models *workspace
 * packages* (one engine entry for the whole crate) and their declared dependencies;
 * this models *modules inside one crate* and the `crate::` references between them.
 * Merging would either force 38 library modules into a TS-package model or
 * collapse the graph back to the single node that made it invisible. Keeping the
 * baseline here also keeps the fix cheap: a new edge is a one-line diff in a file
 * whose entire content is this graph, not a fingerprint refresh in a shared model.
 *
 * The ratchet
 * -----------
 * Two-way, matching `scan-hardcoded-rust` and `check-locale-orphans`:
 *   - a pair in the code but not in the baseline FAILS (new coupling needs a decision);
 *   - a baseline pair no longer in the code FAILS (the record cannot rot into fiction).
 * Both directions print the evidence lines they were judged on. Re-record with:
 *
 *   bun run check:rust-module-deps -- --update
 *
 * `--list` prints every pair with its evidence and the in-degree table.
 *
 * Two self-checks run on every invocation, not behind a flag: a fixture battery
 * over the pure extractor, and assertions against the live tree (a known real edge
 * must be found, a known-absent pair must not be reported, every pair must be
 * closed over the module set). A broken extractor reports the same "0 new, 0
 * stale" as a clean crate, and a green line a reader cannot distinguish from a
 * dead scanner is the failure these checks exist to prevent.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CRATE_SRC = join(ROOT, 'packages', 'kimi-agent', 'src');
const BASELINE = join(ROOT, 'scripts', 'rust-module-deps-baseline.json');

const BASELINE_NOTE =
  'Intra-crate module dependency graph of packages/kimi-agent, keyed `from -> to` at ' +
  'top-level-module granularity. Two-way ratchet: a new unrecorded pair fails, and so does a ' +
  'recorded one that is gone. Re-record with `bun run check:rust-module-deps -- --update`; see ' +
  'the script header for the extraction rules and the blind spots.';

// ── source preparation ──────────────────────────────────────────────────────

const countNewlines = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
};

/**
 * Blank out comments and string literals while preserving line count, so a
 * `crate::` mention inside a doc example, a log message or a raw SQL block
 * cannot be read as a dependency.
 *
 * A scanner rather than a set of regexes: `//` inside a string, `"` inside a
 * comment and `r#"…"#` all occur in this crate, and a regex that gets one of
 * them wrong invents edges. Char literals are skipped only when they close on
 * the same character — `'a` in a lifetime is not a literal, and consuming it
 * would swallow the rest of the line.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  let blockDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (blockDepth > 0) {
      if (two === '/*') {
        blockDepth++;
        i += 2;
        continue;
      }
      if (two === '*/') {
        blockDepth--;
        i += 2;
        continue;
      }
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      blockDepth++;
      i += 2;
      continue;
    }
    const wordBefore = /[\w]/.test(src[i - 1] ?? ' ');
    // `r"…"` / `r#"…"#` / `br#"…"#` — only when `r` opens a token, so an
    // identifier ending in `r` cannot be misread as one.
    const rawAt = !wordBefore && c === 'r' ? i : !wordBefore && c === 'b' && src[i + 1] === 'r' ? i + 1 : -1;
    if (rawAt !== -1) {
      const m = src.slice(rawAt).match(/^r(#*)"/);
      if (m) {
        const close = `"${m[1]}`;
        const start = rawAt + m[0].length;
        const end = src.indexOf(close, start);
        const stop = end === -1 ? src.length : end + close.length;
        out += '\n'.repeat(countNewlines(src.slice(i, stop)));
        i = stop;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += '\n'.repeat(countNewlines(src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === "'") {
      const m = src.slice(i).match(/^'(?:\\.|[^'\\])'/);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ── module universe ─────────────────────────────────────────────────────────

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target') continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.rs')) {
      yield full;
    }
  }
}

/** Top-level module of a path under src/: `tools/mod.rs` -> `tools`, `env.rs` -> `env`. */
const moduleOf = (relPath) => {
  const head = relPath.split('/')[0];
  return head.endsWith('.rs') ? head.slice(0, -3) : head;
};

// ── extraction ──────────────────────────────────────────────────────────────

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const USE_CRATE = /\buse\s+crate\s*::\s*/g;
const INLINE_CRATE = /(?:^|[^:\w$])crate\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/** The idents at the top level of a `{…}` use-group, resolving nested groups to their top segment. */
function groupTargets(text, openIdx) {
  const targets = [];
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { targets, end: text.length };
  const body = text.slice(openIdx + 1, end);
  depth = 0;
  let atItemStart = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) atItemStart = true;
    else if (atItemStart && depth === 0 && /[A-Za-z_]/.test(c)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(body);
      if (m) {
        targets.push(m[0]);
        i += m[0].length - 1;
        atItemStart = false;
      }
    } else if (!/\s/.test(c) && depth === 0) {
      atItemStart = false;
    }
  }
  return { targets, end };
}

/**
 * Every `crate::<mod>` reference in one module's source, as target -> line numbers.
 * Pure over its inputs so the extractor's own cases below can pin it.
 */
function extractFromSource(src, modules, from) {
  const code = stripNonCode(src);
  const found = new Map();
  const push = (target, index) => {
    if (!modules.has(target) || target === from) return;
    const line = countNewlines(code.slice(0, index)) + 1;
    const lines = found.get(target) ?? [];
    if (!lines.includes(line)) lines.push(line);
    found.set(target, lines);
  };

  USE_CRATE.lastIndex = 0;
  let m;
  while ((m = USE_CRATE.exec(code)) !== null) {
    const at = m.index + m[0].length;
    if (code[at] === '{') {
      const { targets, end } = groupTargets(code, at);
      for (const target of targets) push(target, m.index);
      USE_CRATE.lastIndex = end;
      continue;
    }
    IDENT.lastIndex = at;
    const ident = IDENT.exec(code);
    if (ident) push(ident[0], m.index);
  }

  INLINE_CRATE.lastIndex = 0;
  while ((m = INLINE_CRATE.exec(code)) !== null) push(m[1], m.index);

  return found;
}

// ── extractor self-check ────────────────────────────────────────────────────

/**
 * Fixture cases for the pure extractor, run on every invocation.
 *
 * A ratchet whose extractor has silently stopped matching still reports "0 new,
 * 0 stale" — the green of a broken scanner and the green of a clean tree are
 * indistinguishable. These cases are the cheapest way to tell them apart without
 * a second file: each one is a string and the pair set it must produce. Cases 4-9
 * matter most: without the string/comment stripper each of them *invents* an edge,
 * and the stripper is the part most likely to rot.
 */
const EXTRACTOR_CASES = [
  { why: 'single-path use statement', src: 'use crate::alpha::Thing;', expect: ['m -> alpha'] },
  { why: 'grouped use statement', src: 'use crate::{beta, gamma};', expect: ['m -> beta', 'm -> gamma'] },
  {
    why: 'nested group resolves to its top segment',
    src: 'use crate::{beta::{a, b}, gamma::types::X};',
    expect: ['m -> beta', 'm -> gamma'],
  },
  { why: 'line comment does not count', src: '// use crate::alpha::Thing;', expect: [] },
  { why: 'doc comment does not count', src: '/// use crate::alpha::Thing;', expect: [] },
  { why: 'block comment does not count', src: '/* use crate::alpha::Thing; */', expect: [] },
  { why: 'string literal does not count', src: 'let s = "use crate::alpha::Thing";', expect: [] },
  { why: 'raw string literal does not count', src: 'let s = r#"crate::alpha::Thing"#;', expect: [] },
  { why: 'macro metavariable does not count', src: '$crate::alpha!(x);', expect: [] },
  { why: 'a different crate does not count', src: 'mycrate::alpha::go();', expect: [] },
  { why: 'inline path counts', src: 'let x = crate::delta::Thing::new();', expect: ['m -> delta'] },
  {
    why: 'repeated inline sites collapse to one pair',
    src: 'crate::delta::a();\ncrate::delta::b();',
    expect: ['m -> delta'],
  },
  { why: 'a non-module target is filtered', src: 'crate::ghost::go();', expect: [] },
  { why: 'a self reference is not an edge', src: 'use crate::m::Thing;', expect: [] },
];

function selfCheckExtractor() {
  const modules = new Set(['m', 'alpha', 'beta', 'gamma', 'delta']);
  let failed = 0;
  for (const { why, src, expect } of EXTRACTOR_CASES) {
    const actual = [...extractFromSource(src, modules, 'm').keys()]
      .map((target) => `m -> ${target}`)
      .sort();
    const wanted = [...expect].sort();
    if (actual.join('|') !== wanted.join('|')) {
      failed++;
      console.error(`  extractor case failed (${why}):`);
      console.error(`    source:   ${JSON.stringify(src)}`);
      console.error(`    expected: ${wanted.join(', ') || '(none)'}`);
      console.error(`    actual:   ${actual.join(', ') || '(none)'}`);
    }
  }
  if (failed > 0) {
    console.error(`check-rust-module-deps: ${failed} extractor self-check case(s) failed.`);
    process.exit(1);
  }
  return EXTRACTOR_CASES.length;
}

// ── graph ───────────────────────────────────────────────────────────────────

/**
 * Pairs asserted against the live tree on every run.
 *
 * `KNOWN_EDGE` is a real, long-standing dependency (`turn_loop` calls
 * `crate::tools::…` in `run_turn.rs` outside and inside tests, so it survives any
 * plausible rearrangement of that file). `ABSENT_EDGE` is a pair no module could
 * plausibly acquire by accident — `env` is a leaf with zero outgoing edges — so if
 * it ever reports, the extractor is inventing edges rather than the crate changing.
 */
const KNOWN_EDGE = 'turn_loop -> tools';
const ABSENT_EDGE = 'env -> server';

/**
 * Assertions that prove the extractor is still reading this crate, not merely
 * matching its fixtures. Cheap (it only inspects the graph already built) and
 * always on: a ratchet that has stopped looking reports exactly the same green as
 * a clean tree, and that is the failure mode this gate exists to avoid.
 */
function checkLiveTree(found) {
  const problems = [];
  if (!found.has(KNOWN_EDGE)) {
    problems.push(
      `known real edge '${KNOWN_EDGE}' was not found — the extractor is no longer reading the ` +
        `crate it is supposed to gate. Do not re-record a baseline against a broken extractor.`,
    );
  }
  if (found.has(ABSENT_EDGE)) {
    problems.push(`non-existent edge '${ABSENT_EDGE}' was reported — the extractor is inventing edges`);
  }
  return problems;
}

function collectGraph() {
  const files = [...walk(CRATE_SRC)];
  const modules = new Set(files.map((file) => moduleOf(relative(CRATE_SRC, file).split('\\').join('/'))));
  const sites = new Map();
  let siteCount = 0;
  for (const file of files) {
    const rel = relative(CRATE_SRC, file).split('\\').join('/');
    const from = moduleOf(rel);
    const found = extractFromSource(readFileSync(file, 'utf-8'), modules, from);
    for (const [target, lines] of found) {
      const key = `${from} -> ${target}`;
      const where = sites.get(key) ?? [];
      for (const line of lines) where.push(`packages/kimi-agent/src/${rel}:${line}`);
      sites.set(key, where);
      siteCount += lines.length;
    }
  }
  return { files: files.length, modules, sites, siteCount };
}

/**
 * Code-unit order, stated explicitly rather than left to `.sort()`'s default.
 * The baseline file's diff is the interface a reviewer reads, so the ordering has
 * to be a property of the data rather than of the engine that wrote it.
 */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const sortedEdges = (sites) => [...sites.keys()].sort(byCodeUnit);

/** @returns {Set<string>} the recorded `from -> to` pairs; empty when the file is absent or malformed. */
function loadBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE, 'utf-8')).edges;
    // A malformed baseline must fail as a comparison, not as a crash later: a
    // non-array here would otherwise surface as "everything is new".
    return new Set(Array.isArray(raw) ? raw.filter((edge) => typeof edge === 'string') : []);
  } catch {
    return new Set();
  }
}

function inDegree(sites) {
  const degree = new Map();
  for (const key of sites.keys()) {
    const target = key.split(' -> ')[1];
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  return [...degree].sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]));
}

function writeBaseline(edges, stats) {
  const payload = {
    note: BASELINE_NOTE,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'packages/kimi-agent/src',
    extraction: {
      granularity: 'top-level module: first path segment under src/ (directory name or .rs file stem)',
      patterns: [
        'use crate::<mod>::… (single-path use statement)',
        'use crate::{a, b::c, …} (grouped use; nested groups resolve to their top segment)',
        'crate::<mod>::… (inline path in expression or type position)',
      ],
      excludes: [
        'comments (line, doc, block) and string / raw-string literals',
        'tests/** and build.rs, which reach the library as an external crate (kimi_agent::…)',
        'the crate boundary: main.rs reaches the library through kimi_agent::… and contributes no edges today',
      ],
      includesTestCode: true,
      files: stats.files,
      modules: stats.modules.size,
      sites: stats.siteCount,
    },
    edges,
  };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const update = process.argv.includes('--update');
  const list = process.argv.includes('--list');

  const cases = selfCheckExtractor();
  const stats = collectGraph();
  const found = stats.sites;
  const recorded = loadBaseline();

  console.log(
    `check-rust-module-deps: ${stats.files} .rs files under packages/kimi-agent/src, ` +
      `${stats.modules.size} top-level modules, ${found.size} distinct module pairs ` +
      `(${stats.siteCount} reference sites)`,
  );
  console.log(`  extractor self-check: ${cases}/${cases} cases passed`);

  // Live-tree self-check, run on every invocation. The case battery above proves
  // the extractor handles the syntax it was written for; this proves it is still
  // reading *this* tree. Without it, "0 new, 0 stale" looks identical whether the
  // extractor works or has silently stopped matching, and a dead ratchet that
  // reports green is worse than no ratchet.
  const liveProblems = checkLiveTree(found);
  if (liveProblems.length > 0) {
    console.error('\nFAIL: extractor self-check against the live tree:');
    for (const problem of liveProblems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`  live self-check: '${KNOWN_EDGE}' found, '${ABSENT_EDGE}' not reported`);

  if (update) {
    writeBaseline(sortedEdges(found), stats);
    console.log(`\nbaseline written: ${found.size} edges -> scripts/rust-module-deps-baseline.json`);
    return;
  }

  if (list) {
    console.log('\n--- in-degree (module -> number of distinct importers) ---');
    for (const [mod, n] of inDegree(found)) console.log(`  ${String(n).padStart(3)}  ${mod}`);
    console.log('\n--- edges (first evidence site each) ---');
    for (const key of sortedEdges(found)) console.log(`  ${key.padEnd(44)} ${found.get(key)[0]}`);
    return;
  }

  const added = sortedEdges(found).filter((key) => !recorded.has(key));
  const removed = [...recorded].filter((key) => !found.has(key));

  console.log(`\nrecorded: ${recorded.size}   found: ${found.size}`);
  console.log(`new (unrecorded): ${added.length}   stale (recorded but gone): ${removed.length}`);

  let failed = false;
  if (added.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${added.length} module pair(s) not recorded in the baseline.`);
    for (const key of added) {
      console.log(`  ${key}`);
      for (const site of found.get(key).slice(0, 3)) console.log(`      ${site}`);
      const more = found.get(key).length - 3;
      if (more > 0) console.log(`      … and ${more} more site(s)`);
    }
    console.log('\n  A new cross-module dependency is a design decision, not an accident:');
    console.log('    bun run check:rust-module-deps -- --list      # the full graph with evidence');
    console.log('    bun run check:rust-module-deps -- --update    # record it');
  }
  if (removed.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${removed.length} recorded pair(s) no longer present — re-record:`);
    for (const key of removed.slice(0, 40)) console.log(`  ${key}`);
    if (removed.length > 40) console.log(`  … and ${removed.length - 40} more`);
    console.log('    bun run check:rust-module-deps -- --update');
  }
  if (failed) process.exit(1);
}

main();
