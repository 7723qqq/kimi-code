#!/usr/bin/env bun
/**
 * CI check: no new user-facing prose literals outside `t()`.
 *
 * The gap this closes: `check-t-call-coverage.mjs` only proves that a `t()` call
 * has a locale key, and `scan-hardcoded-v2.mjs` only finds source strings that
 * already exist in a locale file. A literal that was never localized matches
 * neither, so every new hardcoded string passed every gate. This walks the
 * UI trees and reports string literals that read as prose and are not inside a
 * `t()` call.
 *
 * The detector is the one already proven in `check-status-surface-i18n.mjs`:
 * strip comments and module specifiers, drop literals inside `t(...)`, and keep
 * what is left if it looks like a sentence (two or more word-like tokens, or a
 * capitalized single word ending in punctuation).
 *
 * Existing violations are recorded in `scripts/no-hardcoded-prose-baseline.txt`
 * as `path  count` lines — a shrink-only ledger, same shape as
 * `no-comments-baseline.txt`. A file may not exceed its recorded count, and a
 * newly violating file fails outright. Lower a number when you localize
 * strings; the ledger reports entries that dropped so it cannot rot.
 *
 * Usage:
 *   bun scripts/check-no-hardcoded-prose.mjs                # verify against the ledger
 *   bun scripts/check-no-hardcoded-prose.mjs --print-counts  # regenerate ledger body
 *   bun scripts/check-no-hardcoded-prose.mjs --list          # list every finding
 *
 * Exit code: 0 when within the ledger, 1 otherwise.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE_PATH = join(ROOT, 'scripts/no-hardcoded-prose-baseline.txt');

const ROOTS = [
  'apps/kimi-code/src/tui',
  'apps/kimi-code/src/cli',
  'apps/kimi-inspect/src',
  'apps/vscode/src',
  'apps/vscode/webview-ui/src',
  'apps/vis/web/src',
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-web',
  'coverage',
  '.vite',
  '__snapshots__',
  'locales',
  'i18n',
  'generated',
]);

const SKIP_FILE_RE = /(?:\.test\.|\.spec\.|\.d\.ts$|\.min\.)/;

/**
 * Vue attribute bindings and event handlers are code, not copy
 * (`"turns.length === 0 && !loading"`, `"(id) => emit('fork', id)"`).
 */
const CODE_EXPRESSION_RE =
  /(?:===|!==|&&|\|\||=>|\?\?|\bemit\s*\(|\bref\s*\(|\bemit\b|\.length\b|\btypeof\b|\(\s*\)\s*=>|\bthis\.|\bfunction\b|=>)/;

/**
 * Commander argument syntax (`-m, --model <model>`, `[on|off] | <task>`) is a
 * usage grammar, not copy.
 */
const USAGE_SYNTAX_RE = /<\w[\w-]*>|(?:^|\s)-{1,2}[a-zA-Z][\w-]*|^\[[^\]]*\]/;

/**
 * A literal whose tokens are dominated by hyphen/colon/bracket shapes
 * (`text-sm leading-none`, `focus:bg-accent data-open:text-accent-foreground`)
 * is a stylesheet, not copy.
 */
const CLASSISH_TOKEN_RE = /[-:[{*\\]/;
const UTILITY_CHARS_RE = /^[-a-z0-9:[\]{}()#./%*&=,!<>~_$@\\]+$/i;

function looksLikeClassList(trimmed) {
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return false;
  if (!tokens.every((token) => UTILITY_CHARS_RE.test(token))) return false;
  const classish = tokens.filter((token) => CLASSISH_TOKEN_RE.test(token)).length;
  return classish * 2 >= tokens.length;
}

/**
 * Directives and identifier-shaped tokens (camelCase, snake_case, `visibleSessions`)
 * are code, not copy.
 */
const DIRECTIVE_RE = /^use (client|server|strict)$/;
const CAMEL_TOKEN_RE = /[a-z][A-Z]|[A-Z]{2,}[a-z]/;

/**
 * A literal is user-visible prose when it reads as a phrase rather than an
 * identifier, a class list, a path, a format token, or an embedded expression.
 */
function looksLikeProse(text) {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (/^[\u2500-\u257f\s·▸◆▶✓○●…]+$/u.test(trimmed)) return false;
  if (/^[a-z0-9@#./_%$-]+$/i.test(trimmed)) return false;
  if (/^[\w./-]+\s*[:=]\s*[\w./-]+$/.test(trimmed)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return false;
  if (/^https?:\/\//.test(trimmed)) return false;
  const hasCjk = /[\u4e00-\u9fff]/.test(trimmed);
  if (!hasCjk) {
    if (DIRECTIVE_RE.test(trimmed)) return false;
    if (USAGE_SYNTAX_RE.test(trimmed)) return false;
    if (CODE_EXPRESSION_RE.test(trimmed)) return false;
    if (/['"`]/.test(trimmed)) return false;
    if (looksLikeClassList(trimmed)) return false;
    if (trimmed.split(/\s+/).some((token) => CAMEL_TOKEN_RE.test(token))) return false;
  }
  const words = trimmed
    .split(/\s+/)
    .filter((word) => /^[A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff'’-]*[.,!?…:;]?$/.test(word));
  if (words.length < 2) {
    return /^[A-Z][a-z]+[.!?]$/.test(trimmed) || hasCjk;
  }
  return true;
}

/**
 * Lines whose literals belong to layout, not copy: Tailwind class lists, inline
 * styles, test ids and ARIA plumbing. Their prose-shaped token runs are not
 * user-visible text.
 */
const NON_COPY_LINE_RE =
  /(?:className\s*=|class\s*=|\bstyle\s*=|data-testid|aria-|role=|className:|:class=|class:list|css\s*\()/;

/**
 * Blanks out everything that is not a string literal, preserving both the byte
 * length and every newline so an index into the result is still an index into
 * the original source — which is what makes the reported line numbers correct.
 * Every rule therefore replaces with spaces-in-place rather than deleting.
 */
function stripNonStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\bfrom\s*(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\bimport\s*\(\s*(['"])(?:\\.|(?!\1)[^\\\n])*\1\s*\)/g, (match) =>
      match.replace(/[^\n]/g, ' '),
    )
    .replace(/\brequire\s*\(\s*(['"])(?:\\.|(?!\1)[^\\\n])*\1\s*\)/g, (match) =>
      match.replace(/[^\n]/g, ' '),
    );
}

/**
 * Every string literal in `source`, in order, as `{ index, text }`.
 *
 * Single and double quoted strings are single-line, as before. Template
 * literals are also scanned — they were the gate's largest blind spot, since a
 * `` `Attached ${kind} file` `` sentence is exactly as user-visible as a quoted
 * one. A template's `${...}` interpolations are dropped from `text` (they are
 * code, not copy) but still count toward the match, so the literal's length and
 * position stay correct.
 */
function matchStringLiterals(source) {
  const out = [];
  const pattern = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`]|\$\{[^{}]*\})*)`/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const quoted = match[1] !== undefined;
    const text = quoted ? match[2] : match[3].replace(/\$\{[^{}]*\}/g, ' ');
    out.push({ index: match.index, text });
  }
  return out;
}

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
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lineText = source.split('\n');

  const findings = [];
  for (const { index, text } of matchStringLiterals(scrubbed)) {
    if (inRanges(index, skip)) continue;
    if (!looksLikeProse(text)) continue;
    const line = lineOf(index);
    if (NON_COPY_LINE_RE.test(lineText[line - 1] ?? '')) continue;
    findings.push({ line, text: text.trim() });
  }
  return findings;
}

function walk(target, out) {
  if (!existsSync(target)) return out;
  const stats = statSync(target);
  if (stats.isFile()) {
    if (/\.(ts|tsx|mts|vue)$/.test(target) && !SKIP_FILE_RE.test(target)) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(target, entry.name), out);
    } else if (/\.(ts|tsx|mts|vue)$/.test(entry.name) && !SKIP_FILE_RE.test(entry.name)) {
      out.push(join(target, entry.name));
    }
  }
  return out;
}

/**
 * Files whose literals are protocol values rather than copy: the VS Code
 * notification API hands back the label the user clicked, so the string that is
 * passed in and the string that is compared must be the same literal. They live
 * once, in `NotificationAction`, which is also where a future localization pass
 * would thread a translated label through.
 */
const PROTOCOL_LITERAL_FILES = new Set(['apps/vscode/src/utils/notification-actions.ts']);

function collectCounts() {
  const counts = new Map();
  const details = new Map();
  for (const root of ROOTS) {
    for (const file of walk(resolve(ROOT, root), [])) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (PROTOCOL_LITERAL_FILES.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      const found = findLiterals(source);
      if (found.length === 0) continue;
      counts.set(rel, { count: found.length, digest: digestOf(found) });
      details.set(rel, found);
    }
  }
  return { counts, details };
}

function readBaseline() {
  const baseline = new Map();
  if (!existsSync(BASELINE_PATH)) return baseline;
  for (const raw of readFileSync(BASELINE_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    baseline.set(parts[0], { count: Number(parts[1]), digest: parts[2] });
  }
  return baseline;
}

/**
 * A digest over the accepted literals themselves, so the ledger pins *which*
 * strings were reviewed and not merely how many. The count alone had a hole: a
 * file could swap one accepted literal for a different hardcoded one, keep its
 * count, and pass. Order-insensitive per file, so moving a literal inside the
 * file is not news.
 */
function digestOf(findings) {
  const texts = findings.map((finding) => finding.text).sort();
  return createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 12);
}

function renderBaseline(counts) {
  const entries = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return [
    '# Shrink-only ledger for scripts/check-no-hardcoded-prose.mjs.',
    '# One "path  count  digest" line per file: the number of accepted',
    '# hardcoded-prose literals, and a digest over their text so replacing one',
    '# accepted literal with a different one is detected rather than counted.',
    '# Regenerate with: bun scripts/check-no-hardcoded-prose.mjs --print-counts',
    '# Lower a number when you localize strings; never raise one for new code.',
    '',
    ...entries.map(([path, { count, digest }]) => `${path}  ${count}  ${digest}`),
    '',
  ].join('\n');
}

const args = process.argv.slice(2);
const { counts, details } = collectCounts();

if (args.includes('--list')) {
  for (const [path, found] of [...details.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const finding of found) {
      console.log(`${path}:${finding.line}  ${JSON.stringify(finding.text)}`);
    }
  }
  process.exit(0);
}

if (args.includes('--print-counts')) {
  writeFileSync(BASELINE_PATH, renderBaseline(counts));
  let total = 0;
  for (const entry of counts.values()) total += entry.count;
  console.log(`wrote ${BASELINE_PATH} — ${counts.size} files, ${total} accepted literals`);
  process.exit(0);
}

const baseline = readBaseline();
const errors = [];
const stale = [];
const swapped = [];
let total = 0;

for (const [path, entry] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const { count, digest } = entry;
  total += count;
  const allowed = baseline.get(path);
  if (allowed === undefined) {
    errors.push({ path, count, allowed: 0, isNew: true });
  } else if (count > allowed.count) {
    errors.push({ path, count, allowed: allowed.count, isNew: false });
  } else if (allowed.digest !== undefined && allowed.digest !== digest) {
    swapped.push({ path, count, allowed: allowed.count });
  } else if (count < allowed.count) {
    stale.push({ path, count, allowed: allowed.count });
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ totals: { files: counts.size, literals: total } }, null, 2));
}

if (errors.length > 0) {
  console.error(`check-no-hardcoded-prose: ${errors.length} file(s) exceed the ledger.`);
  for (const error of errors) {
    const found = details.get(error.path) ?? [];
    console.error(`  ${error.path}: ${error.count} literal(s), ledger allows ${error.allowed}`);
    for (const finding of found) {
      console.error(`      :${finding.line}  ${JSON.stringify(finding.text)}`);
    }
  }
  console.error('Wrap user-visible text in t(...) and add the key to both locales.');
  process.exit(1);
}

if (swapped.length > 0) {
  console.error(
    `check-no-hardcoded-prose: ${swapped.length} file(s) replaced an accepted literal with a different one.`,
  );
  for (const entry of swapped) {
    console.error(`  ${entry.path}: ${entry.count} literal(s), same count as the ledger but different text`);
    for (const finding of details.get(entry.path) ?? []) {
      console.error(`      :${finding.line}  ${JSON.stringify(finding.text)}`);
    }
  }
  console.error(
    'A reviewed literal may not be swapped for a new hardcoded one. Wrap the new text in t(...), or run `--print-counts` if the replacement really is the reviewed state.',
  );
  process.exit(1);
}

if (stale.length > 0 && !args.includes('--quiet-stale')) {
  console.log(`check-no-hardcoded-prose: ${stale.length} ledger entr(ies) can be lowered.`);
  for (const entry of stale) {
    console.log(`  ${entry.path}: ${entry.count} (ledger says ${entry.allowed})`);
  }
  console.log('Run `bun scripts/check-no-hardcoded-prose.mjs --print-counts` to record progress.');
}

console.log(
  `check-no-hardcoded-prose: OK — ${total} accepted literals across ${counts.size} files.`,
);
process.exit(0);
