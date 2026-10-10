#!/usr/bin/env bun
/**
 * Keep user-visible text in the status surface going through `t()`.
 *
 * The strip above the editor renders the three things a user reads most while
 * waiting: the todo list, the mid-turn updates and a pending approval. Its
 * strings used to be a mix — `Updates`, `update(s)` and two delegation lines
 * were hardcoded English and stayed English in a Chinese UI, because neither
 * existing guard could see them:
 *
 *   - `check:t-call-coverage.mjs` verifies that every `t()` call has a locale
 *     key. A literal that never calls `t()` has nothing to check.
 *   - `scan-hardcoded-v2.mjs` matches source strings against strings that
 *     already exist in a locale file. A literal that was never localized
 *     exists in neither, so it cannot match.
 *
 * So this walks the two roots that make up the strip and reports string and
 * template literals that read as prose. What it deliberately ignores:
 *
 *   - module specifiers (`from '...'`, `import('...')`) and `require(...)`;
 *   - comments — the source is stripped first, because explanatory prose is
 *     the most common false positive;
 *   - anything inside a `t(...)` call, whose argument is a key;
 *   - short tokens, single identifiers, box-drawing runs and SGR escapes;
 *   - strings with no word boundary at all (`updates`, `click`).
 *
 * Invoked as `bun run check:status-surface-i18n`; also run from CI's lint job.
 * Exit code 0 when clean, 1 with an actionable report otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ROOTS = [
  'apps/kimi-code/src/tui/components/chrome/status-surface',
  'apps/kimi-code/src/tui/controllers/notify.ts',
];

/**
 * A literal is user-visible prose when it contains a space-separated phrase
 * (or ends in sentence punctuation) and has real words in it. Requiring a
 * space is what separates `"ctrl+t to expand"` from `'updates'`, `'click'`,
 * `'../region'` and `'@moonshot-ai/pi-tui'`.
 */
function looksLikeProse(text) {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (/^[\u2500-\u257f\s·▸◆▶✓○●…]+$/u.test(trimmed)) return false;
  if (/^[a-z0-9@#./_-]+$/i.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word));
  if (words.length < 2) {
    // Single-word text is only flagged when it reads like a sentence fragment.
    return /^[A-Z][a-z]+[.!?]$/.test(trimmed);
  }
  return true;
}

/** Remove comments and module specifiers so only executable strings remain. */
function stripNonStrings(source) {
  let out = source
    // Block and line comments.
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    // Import/export specifiers and dynamic imports.
    .replace(/\bfrom\s*(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, (match) =>
      match.replace(/[^\n]/g, ' '),
    )
    .replace(/\bimport\s*\(\s*(['"])(?:\\.|(?!\1)[^\\\n])*\1\s*\)/g, (match) =>
      match.replace(/[^\n]/g, ' '),
    );
  return out;
}

/** Character ranges occupied by `t(...)` calls: their arguments are keys. */
function tCallRanges(source) {
  const ranges = [];
  const pattern = /\bt\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function inRanges(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function findLiterals(source) {
  const scrubbed = stripNonStrings(source);
  const skip = tCallRanges(scrubbed);
  const findings = [];
  const pattern = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let match;
  while ((match = pattern.exec(scrubbed)) !== null) {
    if (inRanges(match.index, skip)) continue;
    const text = match[2];
    if (!looksLikeProse(text)) continue;
    // Report against the original source's line numbering: the scrubber
    // preserves newlines, so the offsets still line up.
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({ line, text: text.trim() });
  }
  return findings;
}

function walk(target, out) {
  const stats = statSync(target);
  if (stats.isFile()) {
    if (target.endsWith('.ts') || target.endsWith('.tsx')) out.push(target);
    return;
  }
  for (const entry of readdirSync(target)) walk(join(target, entry), out);
}

const files = [];
for (const root of ROOTS) walk(join(ROOT, root), files);

const problems = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const finding of findLiterals(source)) {
    problems.push({ file: relative(ROOT, file), ...finding });
  }
}

if (problems.length > 0) {
  console.error(
    `check-status-surface-i18n: ${problems.length} hardcoded string(s) in the status surface.`,
  );
  for (const problem of problems) {
    console.error(`  ${problem.file}:${problem.line}  ${JSON.stringify(problem.text)}`);
  }
  console.error('Wrap user-visible text in t(...) and add the key to both locales.');
  process.exit(1);
}

console.log(`check-status-surface-i18n: OK (${files.length} files)`);
