#!/usr/bin/env node
/**
 * Orphan locale keys: a catalog entry nobody can reach — a ratchet.
 *
 * `check-engine-i18n-parity.mjs` already refuses an unused `engine.*` key, but
 * that is the whole of its reach. The embedded catalog in
 * `packages/kimi-agent/src/locales/en.json` carries 23 top-level namespaces and
 * the engine only ever names `engine.*`; the rest is a live *host* surface,
 * reached through the napi `translate` binding (`native_tool_bindings.rs`) that
 * `apps/kimi-code`'s `t()` and `packages/i18n-runtime` call whenever the native
 * engine is present. Orphan detection therefore has to look at both consumers,
 * and an `engine.*`-only rule is structurally blind to most of the catalog.
 *
 * Reachability, as this gate models it:
 *   - Rust: any string literal in `packages/kimi-agent/src/**\/*.rs` (the engine
 *     resolves through `LocalizedText`, and `translate_embedded` accepts any
 *     key, so every literal is a candidate);
 *   - TypeScript: any quoted token shaped like a key — `t('…')` and the
 *     comparison operands of wire tokens alike. See [`tsKeyLiterals`].
 *
 * Both sides over-approximate on purpose: a key mentioned anywhere counts as
 * reachable. That can only hide an orphan, never invent one, so an orphan this
 * gate reports is genuinely unreachable by either consumer — and the gate may
 * under-report, never over-report. The catalog's own definition sites are
 * excluded from the scan so a key cannot mark itself reachable.
 *
 * 826 of 2429 keys were unreachable when this gate landed. Deleting them is not
 * safe to automate: the over-approximation cannot see a key built at runtime,
 * and a plugin or future host surface may name one. So the debt is recorded
 * instead, in `scripts/locale-orphan-allowlist.json`, and the gate is a
 * two-way ratchet over it:
 *   - a key that is unreachable now but absent from the allowlist FAILS, so the
 *     debt cannot grow;
 *   - an allowlisted key that has become reachable also FAILS, so wiring a key
 *     up cannot leave a stale entry behind.
 *
 * Both are resolved by re-recording with:
 *
 *   bun scripts/check-locale-orphans.mjs --update
 *
 * Usage: node scripts/check-locale-orphans.mjs [--list] [--update]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const AGENT_SRC = join(ROOT, 'packages', 'kimi-agent', 'src');
const CATALOG = join(AGENT_SRC, 'locales', 'en.json');
const ALLOWLIST = join(ROOT, 'scripts', 'locale-orphan-allowlist.json');

/** Where the catalog itself is defined — a key must not mark itself reachable. */
const DEFINITION_SITES = [
  join(ROOT, 'packages', 'kimi-agent', 'src', 'locales'),
  join(ROOT, 'packages', 'i18n-catalog', 'src', 'locales'),
];

/** Consumers whose literals count as a reachability claim. */
const TS_ROOTS = [join(ROOT, 'apps'), join(ROOT, 'packages')];

/** Skip build output and vendored trees; they carry no first-party call sites. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-web',
  'dist-native',
  'coverage',
  'target',
  '.git',
  '.tmp',
]);

const SEP = process.platform === 'win32' ? '\\' : '/';

function* walkFiles(dir, exts) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (DEFINITION_SITES.some((site) => full === site || full.startsWith(`${site}${SEP}`))) {
        continue;
      }
      yield* walkFiles(full, exts);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      yield full;
    }
  }
}

/** Every string literal in a Rust source, unescaped. */
function rustLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '"') continue;
    let value = '';
    let j = i + 1;
    let closed = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\') {
        const next = src[j + 1];
        if (next === 'n') value += '\n';
        else if (next === 't') value += '\t';
        else if (next === 'r') value += '\r';
        else if (next === '"') value += '"';
        else if (next === '\\') value += '\\';
        else value += next ?? '';
        j += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        j += 1;
        break;
      }
      if (ch === '\n') break; // unterminated; not a literal
      value += ch;
      j += 1;
    }
    if (closed) {
      out.push(value);
      i = j - 1;
    }
  }
  return out;
}

/**
 * Every quoted token shaped like a locale key, anywhere in a TypeScript source.
 *
 * Two things this must catch, and one thing it must survive:
 *
 *  - `t('tui.statusMessages.bunRuntimeRequired')` — the host naming a key for
 *    display;
 *  - `=== 'shell.pausedAfterInterruption'` — a *wire token*: the engine emits a
 *    reason string and the host recognises it by comparison, with no `t()` call
 *    anywhere. `scan-hardcoded-v2.mjs` documents that class explicitly, and a
 *    `t()`-only scan reports those keys as orphans, which is a false positive.
 *
 * So the match is on the *shape* (`ns.segment…`) rather than on the call site.
 * That also sidesteps quote pairing: an earlier version tried to pair quotes and
 * an apostrophe in a comment ("don't") swallowed a whole region of literals, so
 * the scan silently found fewer keys than the `t()`-only version it replaced.
 * A token that is not dotted simply does not match, which can only hide an
 * orphan — the safe direction.
 */
function tsKeyLiterals(src) {
  const out = [];
  const re = /['"`]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)['"`]/g;
  let match;
  while ((match = re.exec(src)) !== null) out.push(match[1]);
  return out;
}

/** Deterministic code-unit ordering, so the allowlist diff is stable. */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every dot-path leaf in the catalog. */
function leafKeys(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') leafKeys(value, full, out);
    else out.push(full);
  }
  return out;
}

const reachable = new Set();

let rustFiles = 0;
for (const file of walkFiles(AGENT_SRC, ['.rs'])) {
  rustFiles += 1;
  for (const literal of rustLiterals(readFileSync(file, 'utf8'))) reachable.add(literal);
}

let tsFiles = 0;
for (const root of TS_ROOTS) {
  for (const file of walkFiles(root, ['.ts', '.tsx', '.mts', '.mjs'])) {
    tsFiles += 1;
    for (const key of tsKeyLiterals(readFileSync(file, 'utf8'))) reachable.add(key);
  }
}

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const allKeys = leafKeys(catalog);
const orphans = allKeys.filter((key) => !reachable.has(key)).toSorted(byCodeUnit);
const orphanSet = new Set(orphans);

const byNamespace = new Map();
for (const key of orphans) {
  const ns = key.split('.')[0];
  byNamespace.set(ns, (byNamespace.get(ns) ?? 0) + 1);
}
const namespaceSummary = [...byNamespace.entries()]
  .toSorted((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
  .map(([ns, n]) => `${ns}.* ${n}`)
  .join(', ');

if (process.argv.includes('--list')) {
  for (const key of orphans) console.log(key);
}

const NOTE =
  'Locale keys no consumer can name, recorded as accepted debt. Reachability is ' +
  'over-approximated (any Rust string literal, any t(\'…\') argument), so this list ' +
  'can contain a key built at runtime; it cannot contain a key that is genuinely used. ' +
  'Regenerate with `bun scripts/check-locale-orphans.mjs --update`. See ' +
  'scripts/check-locale-orphans.mjs for the model and its limits.';

if (process.argv.includes('--update')) {
  const payload = {
    note: NOTE,
    recordedAt: new Date().toISOString().slice(0, 10),
    catalogKeys: allKeys.length,
    orphans,
  };
  writeFileSync(ALLOWLIST, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `check-locale-orphans: recorded ${orphans.length} orphan(s) of ${allKeys.length} ` +
      `catalog keys into scripts/locale-orphan-allowlist.json.`,
  );
  process.exit(0);
}

let recorded = [];
try {
  recorded = JSON.parse(readFileSync(ALLOWLIST, 'utf8')).orphans ?? [];
} catch {
  console.error(
    'check-locale-orphans: scripts/locale-orphan-allowlist.json is missing or unreadable.\n' +
      '  Record the current debt with `bun scripts/check-locale-orphans.mjs --update`.',
  );
  process.exit(1);
}
const recordedSet = new Set(recorded);

const added = orphans.filter((key) => !recordedSet.has(key));
const resolved = recorded.filter((key) => !orphanSet.has(key));

console.log(
  `check-locale-orphans: ${allKeys.length} catalog keys, ${orphans.length} unreachable, ` +
    `${recorded.length} recorded (scanned ${rustFiles} Rust files, ${tsFiles} TypeScript files)`,
);

if (added.length > 0 || resolved.length > 0) {
  if (added.length > 0) {
    console.error(`\n✗ ${added.length} NEW unreachable key(s) — the debt grew:`);
    for (const key of added) console.error(`  + ${key}`);
    console.error(
      '\n  Either wire the key up, or accept it and re-record with\n' +
        '  `bun scripts/check-locale-orphans.mjs --update`.',
    );
  }
  if (resolved.length > 0) {
    console.error(`\n✗ ${resolved.length} recorded key(s) are reachable again:`);
    for (const key of resolved) console.error(`  - ${key}`);
    console.error(
      '\n  Good news — something got wired up. Re-record with\n' +
        '  `bun scripts/check-locale-orphans.mjs --update` so the ratchet tightens.',
    );
  }
  console.error(`\n  Current debt by namespace: ${namespaceSummary}`);
  process.exit(1);
}

console.log(
  `✅ locale orphan ratchet holds: ${orphans.length} recorded orphan(s), none added, none resolved`,
);
