#!/usr/bin/env bun
/**
 * check-engine-i18n-parity.mjs — keeps the Rust engine's English fallbacks and
 * the locale files from drifting apart.
 *
 * Every `LocalizedText` in `packages/kimi-agent` carries a locale key plus an
 * English rendering used when no locale is installed. That English string is a
 * second copy of the sentence that already lives in the locale files, and the
 * two have already drifted once (`run_turn.rs`'s compaction-overflow message vs
 * `packages/i18n`'s `compactionOverflowFailed`). This script makes the drift a
 * build failure instead of a silent divergence.
 *
 * Three checks, all fatal:
 *   1. Every key used in Rust exists in BOTH the en and zh locale trees.
 *   2. The Rust English fallback is byte-identical to the en locale value,
 *      once Rust's `{name}` placeholders are normalized to i18n's `{{name}}`.
 *   3. Every `engine.*` key in the locale trees is used by some `LocalizedText`
 *      — an orphan means a Rust call site typo'd its key, which would render
 *      English forever with nothing else noticing.
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
const LOCALE_EN = join(ROOT, 'apps', 'kimi-code', 'src', 'i18n', 'locales', 'en.json');
const LOCALE_ZH = join(ROOT, 'apps', 'kimi-code', 'src', 'i18n', 'locales', 'zh.json');

/** The namespace every engine key must live under, in both locale trees. */
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
 * Collect the top-level arguments of the call whose `(` sits at `open`,
 * returning each argument's source text. Splits on commas that are outside
 * nested parens/brackets and outside string literals, so `format!(..)` and
 * `i18n_params![..]` survive as single arguments.
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

/**
 * Normalize a Rust `format!` template into i18n's placeholder syntax.
 *
 * `format!("Denied by user rule: {rule}: {why}")` becomes
 * `Denied by user rule: {{rule}}: {{why}}`. Escaped braces (`{{` / `}}`, which
 * Rust renders as literal braces) are left alone.
 */
function normalizeTemplate(template) {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '{') {
      out += '{{';
      i += 2;
      continue;
    }
    if (ch === '}' && template[i + 1] === '}') {
      out += '}}';
      i += 2;
      continue;
    }
    if (ch === '{') {
      const close = template.indexOf('}', i);
      if (close === -1) {
        out += ch;
        i += 1;
        continue;
      }
      const name = template.slice(i + 1, close);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        out += `{{${name}}}`;
        i = close + 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The English template a `LocalizedText` carries, taken from its second
 * argument: a plain literal for `plain`, or the literal inside `format!(..)`
 * for `fmt`.
 */
function extractEnglish(argSrc) {
  const formatMatch = argSrc.startsWith('format!(');
  const body = formatMatch ? argSrc.slice('format!('.length, argSrc.lastIndexOf(')')) : argSrc;
  const quote = body.indexOf('"');
  if (quote === -1) return null;
  const literal = readStringLiteral(body, quote);
  if (!literal) return null;
  return normalizeTemplate(literal.value);
}

/**
 * Byte ranges covered by a `#[cfg(test)]` module.
 *
 * Test fixtures deliberately use keys that do not exist in any locale — that is
 * how the fallback path gets covered — so they are out of scope for parity.
 * Returns `[start, end)` pairs.
 */
function testModuleRanges(src) {
  const ranges = [];
  // Anchored to line start so a `#[cfg(test)]` mentioned inside a doc comment
  // (lib.rs quotes its own test module in prose) does not open a range that
  // swallows the production code between it and the real module.
  const re = /^[ \t]*#\[cfg\(test\)\]/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    // Find the `mod <name> {` that follows the attribute.
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

/** Every `LocalizedText::plain` / `::fmt` in the crate, keyed by locale key. */
function collectEngineStrings() {
  const found = new Map();
  /** `plain` sites whose English text carries a `{name}` placeholder. */
  const misusedPlain = [];
  for (const file of walkRs(AGENT_SRC)) {
    const src = readFileSync(file, 'utf8');
    const testRanges = testModuleRanges(src);
    const re = /LocalizedText::(plain|fmt)\(/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      if (inRanges(match.index, testRanges)) continue;
      const open = match.index + match[0].length - 1;
      const args = readCallArgs(src, open);
      if (!args || args.length < 2) continue;

      const keyQuote = args[0].indexOf('"');
      if (keyQuote === -1) continue;
      const keyLiteral = readStringLiteral(args[0], keyQuote);
      if (!keyLiteral) continue;

      const english = extractEnglish(args[1]);
      if (english === null) continue;

      const line = src.slice(0, match.index).split('\n').length;

      // `plain` never interpolates, so a `{name}` in its English text would
      // reach the user as literal braces. `fmt` is the constructor that takes
      // params. The template comparison below cannot catch this on its own:
      // the locale entry may legitimately carry the same placeholder, so the
      // two agree while the unwired fallback is still broken.
      if (match[1] === 'plain' && /\{[A-Za-z_]/.test(english)) {
        misusedPlain.push({ file: relative(ROOT, file), line, key: keyLiteral.value, english });
      }

      const prior = found.get(keyLiteral.value);
      // First occurrence wins, so the reported location is the canonical one;
      // duplicates are reported separately.
      if (!prior) {
        found.set(keyLiteral.value, {
          file: relative(ROOT, file),
          line,
          english,
          kind: match[1],
        });
      }
    }
  }
  return { found, misusedPlain };
}

// ---------------------------------------------------------------------------
// Locale trees
// ---------------------------------------------------------------------------

/**
 * A parsed locale tree. Typed loosely — only string leaves are ever read.
 *
 * @typedef {{ [key: string]: string | LocaleTree }} LocaleTree
 */

/** @returns {LocaleTree} */
function readLocale(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveKey(tree, key) {
  let current = tree;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * @param {LocaleTree} tree
 * @param {string} namespace
 * @param {string} [prefix]
 * @returns {string[]}
 */
function collectNamespaceKeys(tree, namespace, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (full.startsWith(`${namespace}.`)) out.push(full);
    } else if (value && typeof value === 'object') {
      out.push(...collectNamespaceKeys(value, namespace, full));
    }
  }
  return out;
}

/**
 * The `{{name}}` placeholders in `text`, as a sorted comma list, or `(none)`.
 * Returning the marker here — rather than `||`-ing at each call site — keeps
 * an empty list distinguishable from a missing one.
 */
function placeholderList(text) {
  const found = text.match(/{{\w+}}/g) ?? [];
  return found.length > 0 ? found.toSorted().join(',') : '(none)';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const failures = [];
const warnings = [];

const { found: engineStrings, misusedPlain } = collectEngineStrings();
const en = readLocale(LOCALE_EN);
const zh = readLocale(LOCALE_ZH);

if (engineStrings.size === 0) {
  console.error(
    'check-engine-i18n-parity: found no LocalizedText in packages/kimi-agent/src — the scanner is broken.',
  );
  process.exit(1);
}

for (const { file, line, key, english } of misusedPlain) {
  failures.push(
    `PLAIN ${key} (${file}:${line}) is built with LocalizedText::plain but its English text ` +
      `carries a placeholder, which plain never interpolates — the user would see literal ` +
      `braces.\n        english: ${JSON.stringify(english)}\n` +
      `        fix: use LocalizedText::fmt with the matching i18n_params! entry`,
  );
}

for (const [key, entry] of engineStrings) {
  const where = `${entry.file}:${entry.line}`;

  if (!key.startsWith(`${ENGINE_NAMESPACE}.`)) {
    failures.push(`KEY   ${key} at ${where} is outside the "${ENGINE_NAMESPACE}." namespace`);
    continue;
  }

  const enValue = resolveKey(en, key);
  const zhValue = resolveKey(zh, key);

  if (enValue === undefined) {
    failures.push(`EN    ${key} (${where}) has no entry in ${relative(ROOT, LOCALE_EN)}`);
  } else if (enValue !== entry.english) {
    failures.push(
      `EN    ${key} (${where}) fallback drifted from the locale value\n` +
        `        rust:   ${JSON.stringify(entry.english)}\n` +
        `        locale: ${JSON.stringify(enValue)}`,
    );
  } else if (placeholderList(enValue) !== placeholderList(entry.english)) {
    failures.push(
      `EN    ${key} (${where}) placeholders differ from the locale value\n` +
        `        rust:   ${placeholderList(entry.english)}\n` +
        `        locale: ${placeholderList(enValue)}`,
    );
  }

  if (zhValue === undefined) {
    failures.push(`ZH    ${key} (${where}) has no entry in ${relative(ROOT, LOCALE_ZH)}`);
  }
}

// An `engine.*` locale key nobody uses means a Rust call site typo'd its key:
// that message renders English forever and nothing else would notice.
const enKeys = new Set(collectNamespaceKeys(en, ENGINE_NAMESPACE));
const zhKeys = new Set(collectNamespaceKeys(zh, ENGINE_NAMESPACE));

for (const key of enKeys) {
  if (!engineStrings.has(key)) {
    failures.push(
      `ORPHAN ${key} exists in the locale trees but no LocalizedText uses it — ` +
        `a Rust call site most likely typo'd its key and is falling back to English`,
    );
  }
}
for (const key of zhKeys) {
  if (!enKeys.has(key)) {
    warnings.push(`ZH-only locale key: ${key}`);
  }
}

for (const warning of warnings) {
  console.warn(`⚠️  ${warning}`);
}

if (failures.length > 0) {
  console.error(
    `\n❌ engine i18n parity failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n`,
  );
  for (const failure of failures) {
    console.error(`  ${failure}\n`);
  }
  console.error(
    'Fix the Rust fallback or the locale entry so the two agree, then re-run ' +
      '`bun scripts/generate-locale-json.cjs` if you edited a locale .ts file.',
  );
  process.exit(1);
}

console.log(
  `✅ engine i18n parity OK: ${engineStrings.size} LocalizedText keys match the ` +
    `${enKeys.size} "${ENGINE_NAMESPACE}.*" locale keys in en and zh.`,
);
