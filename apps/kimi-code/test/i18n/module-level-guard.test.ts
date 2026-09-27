import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard: forbid evaluating a translation (`t(...)`) at MODULE LOAD TIME.
 *
 * Why: the i18n singleton picks its locale from env detection when the module
 * is first imported, and the real locale (from `tui.toml`) is only applied
 * later via `setLocale()` in `run-shell.ts`. Any translation evaluated in a
 * module-top-level declaration captures the early English default and never
 * updates — so the string stays English even after the user selected Chinese.
 *
 * The fix is always to evaluate translations lazily, inside a function/getter
 * that runs on the render/use path, e.g.:
 *
 *   // BAD  — frozen at import time
 *   const TITLE = t('some.key');
 *   // GOOD — re-read on every call
 *   function getTitle(): string { return t('some.key'); }
 *
 * Detection strategy (intentionally conservative): we only inspect
 * module-top-level `const`/`let`/`var` declarations (brace/bracket/paren depth
 * 0). A declaration is flagged when its initializer calls `t(...)` directly AND
 * contains no function boundary (`=>` or `function`) — i.e. the translation runs
 * immediately at import, not inside a deferred callback. Declarations whose
 * initializer is (or contains) a function are left alone, since there the `t()`
 * runs when that function is called.
 * `function`/method/getter declarations and class fields are never top-level
 * `const` declarations, so lazy getters and in-method `t()` calls pass.
 *
 * Note: string and template-literal contents are stripped before scanning, so
 * a top-level template literal embedding `${t(...)}` is not detected. Don't do
 * that either — wrap it in a getter.
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src');

// The i18n module itself defines `t` and legitimately references the message
// tables at load time; exclude it from the scan.
const EXCLUDED_DIRS = new Set(['i18n']);

function walk(dir: string, files: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), files);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        files.push(join(dir, entry.name));
      }
    }
  } catch {
    /* skip */
  }
  return files;
}

/**
 * Replace comment and string/template-literal contents with spaces while
 * preserving newlines (so line numbers and structural brackets stay accurate).
 */
function stripStringsAndComments(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1] : '';
    const nl = c === '\n' ? '\n' : ' ';
    switch (state) {
      case 'code':
        if (c === '/' && c2 === '/') {
          state = 'line';
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '/' && c2 === '*') {
          state = 'block';
          out += '  ';
          i += 2;
          continue;
        }
        if (c === "'") {
          state = 'sq';
          out += ' ';
          i += 1;
          continue;
        }
        if (c === '"') {
          state = 'dq';
          out += ' ';
          i += 1;
          continue;
        }
        if (c === '`') {
          state = 'tpl';
          out += ' ';
          i += 1;
          continue;
        }
        out += c;
        i += 1;
        continue;
      case 'line':
        if (c === '\n') {
          state = 'code';
          out += '\n';
        } else out += ' ';
        i += 1;
        continue;
      case 'block':
        if (c === '*' && c2 === '/') {
          state = 'code';
          out += '  ';
          i += 2;
          continue;
        }
        out += nl;
        i += 1;
        continue;
      case 'sq':
        if (c === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === "'") {
          state = 'code';
          out += ' ';
          i += 1;
          continue;
        }
        out += nl;
        i += 1;
        continue;
      case 'dq':
        if (c === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '"') {
          state = 'code';
          out += ' ';
          i += 1;
          continue;
        }
        out += nl;
        i += 1;
        continue;
      case 'tpl':
        if (c === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '`') {
          state = 'code';
          out += ' ';
          i += 1;
          continue;
        }
        out += nl;
        i += 1;
        continue;
    }
  }
  return out;
}

const T_CALL = /(?<![.\w])t\s*\(/g;
const TOP_DECL = /^\s*(?:export\s+)?(?:const|let|var)\s/;

/**
 * Tokens that open a deferred callback body. A `t()` that follows one of these
 * runs when the callback is called, not when the declaration is evaluated.
 *
 * The getter form matters for a declaration that *contains* the getter — e.g.
 * `export const CoreErrors = { info: { internal: { get title() { … } } } }`.
 * The getter is the top-level boundary of the `t()` inside it, so without
 * recognizing it the guard would demand a getter be wrapped in yet another
 * getter, which is impossible.
 */
const FUNCTION_BOUNDARY = /=>/;
const FUNCTION_KEYWORD = /\bfunction\b/;
const FUNCTION_BOUNDARY_GLOBAL = new RegExp(FUNCTION_BOUNDARY, 'g');
const FUNCTION_KEYWORD_GLOBAL = new RegExp(FUNCTION_KEYWORD, 'g');
const GETTER_DECL = /\bget\s+[$A-Z_a-z][$\w]*\s*\(/;
const GETTER_DECL_GLOBAL = new RegExp(GETTER_DECL, 'g');

/** Brace nesting depth of `text` immediately before index `at`. */
function braceDepth(text: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

/**
 * Whether a comma sits at exactly `depth` between `from` and `to`.
 *
 * This is what separates a boundary that *encloses* the call from one that is a
 * sibling of it. In `{ b: () => t('j'), x: t('k') }` the arrow and `t('k')` sit
 * at the same brace depth, and the comma between them proves the call is a
 * sibling rather than the arrow's body — so the arrow must not excuse it.
 */
function hasCommaAtDepth(text: string, from: number, to: number, depth: number): boolean {
  let d = braceDepth(text, from);
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === '{') d++;
    else if (ch === '}') d--;
    else if (ch === ',' && d === depth) return true;
  }
  return false;
}

/** Does a boundary token of `pattern` occurring before `at` enclose the call? */
function boundaryEncloses(declText: string, pattern: RegExp, at: number, callDepth: number): boolean {
  let last: RegExpExecArray | null = null;
  for (const m of declText.slice(0, at).matchAll(pattern)) last = m;
  if (!last) return false;
  const boundaryDepth = braceDepth(declText, last.index);
  if (boundaryDepth < callDepth) return true;
  if (boundaryDepth > callDepth) return false;
  return !hasCommaAtDepth(declText, last.index + last[0].length, at, callDepth);
}

/**
 * A `t()` call at `at` is deferred when a function boundary or getter that
 * *encloses* it appears earlier in the same declaration.
 *
 * Scoping the check to the text before the call, and requiring the boundary to
 * actually enclose rather than merely precede, is what keeps a mixed literal
 * honest. In `{ a: t('x'), b: () => t('y') }` the arrow excuses only `t('y')`.
 * In `{ b: () => t('y'), a: t('x') }` the arrow precedes `t('x')` at the same
 * depth, but the comma between them marks `t('x')` as a sibling, so it stays
 * eager and is reported.
 *
 * A getter follows the same rule: `get a() { return 1; }, b: t('k')` puts the
 * getter and `t('k')` at the same depth with a comma between, so the getter
 * must not exempt the call.
 */
function isDeferredCall(declText: string, at: number): boolean {
  const callDepth = braceDepth(declText, at);
  return (
    boundaryEncloses(declText, FUNCTION_BOUNDARY_GLOBAL, at, callDepth) ||
    boundaryEncloses(declText, FUNCTION_KEYWORD_GLOBAL, at, callDepth) ||
    boundaryEncloses(declText, GETTER_DECL_GLOBAL, at, callDepth)
  );
}

function findOffenders(file: string): { line: number; snippet: string }[] {
  const raw = readFileSync(file, 'utf8');
  const rawLines = raw.split('\n');
  const codeLines = stripStringsAndComments(raw).split('\n');

  const offenders: { line: number; snippet: string }[] = [];
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let collecting = false;
  let declStart = -1;
  let declText = '';

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i] ?? '';
    const atTopLevel = brace <= 0 && bracket <= 0 && paren <= 0;

    if (!collecting && atTopLevel && TOP_DECL.test(line)) {
      collecting = true;
      declStart = i;
      declText = '';
    }
    if (collecting) declText += line + '\n';

    for (const ch of line) {
      if (ch === '{') brace++;
      else if (ch === '}') brace--;
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket--;
      else if (ch === '(') paren++;
      else if (ch === ')') paren--;
    }

    if (collecting && brace <= 0 && bracket <= 0 && paren <= 0 && line.includes(';')) {
      T_CALL.lastIndex = 0;
      let eagerCall = false;
      let match: RegExpExecArray | null;
      while ((match = T_CALL.exec(declText)) !== null) {
        if (!isDeferredCall(declText, match.index)) {
          eagerCall = true;
          break;
        }
      }
      if (eagerCall) {
        offenders.push({ line: declStart + 1, snippet: (rawLines[declStart] ?? '').trim() });
      }
      collecting = false;
    }
  }
  return offenders;
}

describe('i18n module-level translation guard', () => {
  it('forbids evaluating t() in module-top-level declarations', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];
    for (const file of walk(SRC_ROOT)) {
      for (const hit of findOffenders(file)) {
        offenders.push({ file: relative(SRC_ROOT, file), line: hit.line, snippet: hit.snippet });
      }
    }
    expect(
      offenders,
      `Found translations evaluated at module load time. These freeze the ` +
        `English default before the tui.toml locale is applied. Wrap them in a ` +
        `lazy getter (e.g. \`function getX() { return t('key'); }\`) and call it ` +
        `on the render/use path.\n` +
        offenders.map((o) => `  ${o.file}:${String(o.line)}  ${o.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
