#!/usr/bin/env bun
/**
 * check-engine-i18n-parity.mjs — keeps the Rust engine's locale keys and the
 * embedded catalog agreeing on which keys exist.
 *
 * The catalog is compiled into the binary, so there is no longer a second copy
 * of the English text in Rust source to drift from. What is left to check is
 * that the two sides agree on the *keys*, and on how the keys are filled in:
 *
 *   1. every key a `LocalizedText` names exists in the embedded en catalog;
 *   2. every `engine.*` key in the catalog is used by some `LocalizedText`;
 *   3. a `with_params` site binds exactly the `{{placeholders}}` its template
 *      declares — no more, no fewer.
 *
 * Rule 1 catches a typo, which would otherwise render as a bare key. Rule 2
 * catches a key left behind by a rename.
 *
 * Rule 3 is not the two-copy template comparison the old gate did. It compares
 * the `i18n_params!` *names* in Rust against the placeholders in the one
 * surviving copy of the template, which is a check the old gate structurally
 * could not do: while every `LocalizedText` still carried its own English, a
 * key named `count` bound to a template expecting `{{filtered_sensitive}}` was
 * invisible, because the unused `format!` string was what rendered. Now that
 * the catalog is authoritative, the same mismatch puts `{{filtered_sensitive}}`
 * in front of the user. Thirteen such sites existed when the catalog was
 * promoted; this rule is why there are none now.
 *
 * `zh` coverage of every `en` key is covered by `catalog.rs`'s
 * `zh_covers_every_key_en_covers` test instead.
 *
 * Usage:
 *   bun scripts/check-engine-i18n-parity.mjs
 *
 * Exit code: 0 if consistent, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const AGENT_SRC = join(ROOT, 'packages', 'kimi-agent', 'src');
const LOCALE_EN = join(ROOT, 'packages', 'kimi-agent', 'src', 'locales', 'en.json');

/** The namespace every engine key must live under. */
const ENGINE_NAMESPACE = 'engine';

// ---------------------------------------------------------------------------
// Rust source walking
// ---------------------------------------------------------------------------

function walkRs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRs(full));
    } else if (entry.name.endsWith('.rs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read a Rust string literal starting at `open` (the index of its opening
 * quote), returning its unescaped value and the index just past the closing
 * quote. Handles `\"`, `\\` and `\n`; anything else is passed through, which is
 * all the locale strings need.
 */
function readStringLiteral(src, open) {
  let i = open + 1;
  let value = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === 'n') value += '\n';
      else if (next === 't') value += '\t';
      else if (next === 'r') value += '\r';
      else if (next === '\\') value += '\\';
      else if (next === '"') value += '"';
      else value += next ?? '';
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * Byte ranges covered by a `#[cfg(test)]` module.
 *
 * Test fixtures deliberately use keys that do not exist in any locale, so they
 * are out of scope. Returns `[start, end)` pairs.
 */
function testModuleRanges(src) {
  const ranges = [];
  // Anchored to line start, and a `mod <name> {` must follow. Both conditions
  // are load-bearing on this crate: `lib.rs` names `#[cfg(test)] mod
  // engine_tests` inside a doc comment, `acp/mod.rs` declares a brace-less
  // `#[cfg(test)] mod events_map_golden;`, and many files gate a single item.
  // Matching the attribute alone would open a range from the wrong brace and
  // swallow the production code after it.
  const re = /^[ \t]*#\[cfg\(test\)\]/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    const modMatch = /\bmod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.exec(src.slice(match.index));
    if (!modMatch) continue;
    const braceOpen = match.index + modMatch.index + modMatch[0].length - 1;
    let depth = 0;
    let i = braceOpen;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"') {
        const literal = readStringLiteral(src, i);
        if (!literal) break;
        i = literal.end;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          ranges.push([match.index, i + 1]);
          break;
        }
      }
      i += 1;
    }
  }
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

// ---------------------------------------------------------------------------
// Locale tree
// ---------------------------------------------------------------------------

/** Every dot-path leaf in the catalog. */
function leafKeys(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') leafKeys(value, full, out);
    else out.push(full);
  }
  return out;
}

/** The `{{name}}` placeholders a template declares, deduplicated. */
function placeholders(template) {
  return [...new Set((template.match(/{{\w+}}/g) ?? []).map((t) => t.slice(2, -2)))];
}

/** Resolve a dot path in the catalog, or `undefined` when absent. */
function resolveKey(tree, key) {
  let node = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * The `i18n_params![...]` names a call binds.
 *
 * The value expressions are irrelevant here — only the names are, since they
 * are what has to line up with the template. Reading the macro body as source
 * text keeps this independent of how the value is spelled.
 */
function boundParams(argsSrc) {
  return [...new Set([...argsSrc.matchAll(/"([^"]+)"\s*=>/g)].map((m) => m[1]))];
}

/**
 * Collect the top-level arguments of the call whose `(` sits at `open`.
 *
 * Splits on commas outside nested parens/brackets and outside string literals,
 * so the `i18n_params![..]` second argument survives intact.
 */
function readCallArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const literal = readStringLiteral(src, i);
      if (!literal) return null;
      i = literal.end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        const tail = src.slice(start, i).trim();
        if (tail) args.push(tail);
        return args;
      }
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const failures = [];

const enTree = JSON.parse(readFileSync(LOCALE_EN, 'utf8'));
const enKeys = new Set(leafKeys(enTree));
const engineKeysInCatalog = [...enKeys].filter((k) => k.startsWith(`${ENGINE_NAMESPACE}.`));

/** Every locale key a `LocalizedText` names, mapped to its first location. */
const used = new Map();
/** `[key, boundNames, where]` for every `with_params` site. */
const parameterized = [];

for (const file of walkRs(AGENT_SRC)) {
  const src = readFileSync(file, 'utf8');
  const skip = testModuleRanges(src);
  for (const m of src.matchAll(/LocalizedText::(new|with_params)\(\s*"([^"]+)"/g)) {
    if (inRanges(m.index, skip)) continue;
    const [, ctor, key] = m;
    const line = src.slice(0, m.index).split('\n').length;
    const where = `${relative(ROOT, file)}:${line}`;
    if (!used.has(key)) used.set(key, where);
    if (ctor === 'with_params') {
      const open = m.index + m[0].length - '('.length;
      const args = readCallArgs(src, open);
      if (args && args[1]) parameterized.push([key, boundParams(args[1]), where]);
    }
  }
}

if (used.size === 0) {
  console.error(
    'check-engine-i18n-parity: found no LocalizedText in packages/kimi-agent/src — the scanner is broken.',
  );
  process.exit(1);
}

for (const [key, where] of used) {
  if (!key.startsWith(`${ENGINE_NAMESPACE}.`)) {
    failures.push(`KEY     ${key} (${where}) is outside the "${ENGINE_NAMESPACE}." namespace`);
  } else if (!enKeys.has(key)) {
    failures.push(`MISSING ${key} is not in ${relative(ROOT, LOCALE_EN)} (${where})`);
  }
}

// An `engine.*` catalog key nobody names means a call site was renamed or
// deleted: the catalog carries a sentence the user can never see.
for (const key of engineKeysInCatalog) {
  if (!used.has(key)) {
    failures.push(`ORPHAN  ${key} is in the catalog but no LocalizedText uses it`);
  }
}

// A bound name the template has no placeholder for is dead weight; a
// placeholder nobody bound reaches the user as a literal `{{name}}`.
for (const [key, bound, where] of parameterized) {
  const template = resolveKey(enTree, key);
  if (template === undefined) continue; // already reported as MISSING
  const wants = placeholders(template);
  const unbound = wants.filter((w) => !bound.includes(w));
  const unused = bound.filter((b) => !wants.includes(b));
  if (unbound.length || unused.length) {
    failures.push(
      `PARAMS  ${key} (${where}) does not line up with its template\n` +
        `        bound:   ${JSON.stringify(bound)}\n` +
        `        expects: ${JSON.stringify(wants)}\n` +
        `        template: ${JSON.stringify(template)}\n` +
        `        fix: rename the i18n_params! keys to match, character for character`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n❌ engine i18n parity failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log(
  `✅ engine i18n parity OK: ${used.size} LocalizedText keys (${parameterized.length} parameterized) ` +
    `cover the ${engineKeysInCatalog.length} "${ENGINE_NAMESPACE}.*" keys in the embedded en catalog, ` +
    `and every i18n_params! name matches its template.`,
);
