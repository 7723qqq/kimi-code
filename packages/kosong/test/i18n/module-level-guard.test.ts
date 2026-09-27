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
 * `kosong` is imported by the CLI before `setLocale()` runs, so it is exactly
 * the package where this bites.
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
 * 0). A declaration is flagged when at least one of its `t(...)` calls runs
 * immediately at import rather than inside a deferred callback — the
 * translation is not wrapped in `=>`, a `function`, or a `get name(` accessor
 * that encloses it. The check is per call, not per declaration, so a deferred
 * call elsewhere in the same literal does not excuse an eager one.
 *
 * Known blind spots, all inherited from the detector this was adapted from and
 * none of them safe to "fix" casually:
 *
 * - A declaration is only examined once it terminates, and termination means a
 *   `;` seen at depth 0. Semicolon-free code is therefore never examined at
 *   all, which makes the guard's coverage depend on the formatter's semicolon
 *   rule (`oxfmt`). Write semicolons.
 * - Method shorthand inside a top-level literal — `const P = { m() { return
 *   t('j'); } }` — is flagged even though the call is lazy, because only `=>`,
 *   `function` and getters count as deferring. Use an arrow property
 *   (`m: () => t('j')`) or a getter.
 *
 * Note: string and template-literal contents are stripped before scanning, so
 * a top-level template literal embedding `${t(...)}` is not detected. Don't do
 * that either — wrap it in a getter.
 */

// The `t` import in `errors/` is exactly what this guard is about, so no
// directory is excluded: unlike `apps/kimi-code` (which skips its own `i18n/`
// implementation directory), kosong has no module that legitimately resolves
// keys at load time, and skipping one would make the guard vacuous.
const SRC_ROOT = join(__dirname, '..', '..', 'src');
const EXCLUDED_DIRS = new Set<string>();

// No try/catch here on purpose: a wrong `SRC_ROOT` must throw, not degrade into
// an empty scan that reports "clean".
function walk(dir: string, files: string[] = []): string[] {
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
 * A `t()` call at `at` is deferred when a function boundary appears earlier in
 * the same declaration. Scoping that check to the text *before* the call (rather
 * than to the whole declaration) is what keeps a mixed literal honest: in
 * `{ a: t('x'), b: () => t('y') }` the arrow excuses only `t('y')`, and `t('x')`
 * is still reported.
 *
 * A getter is a boundary only for the calls it *encloses*. `get a() { … }` sits
 * at a shallower brace depth than the `t()` inside its own body, but a sibling
 * that follows it — `{ get a() { return 1; }, b: t('k') }` — is back at the
 * literal's own depth, and its `t('k')` is eager. Without the depth test any
 * earlier `get name(` token would blanket-exempt the rest of the declaration,
 * which is the single worst failure mode this guard could have.
 */
function isDeferredCall(declText: string, at: number): boolean {
  const before = declText.slice(0, at);
  if (FUNCTION_BOUNDARY.test(before) || FUNCTION_KEYWORD.test(before)) return true;
  const callDepth = braceDepth(declText, at);
  for (const m of before.matchAll(GETTER_DECL_GLOBAL)) {
    if (braceDepth(declText, m.index) < callDepth) return true;
  }
  return false;
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

describe('kosong i18n module-level translation guard', () => {
  // Walked inside each test rather than at module scope so a bad `SRC_ROOT`
  // fails a named test with its own message instead of erroring during
  // collection and reporting "no tests".
  it('scans a non-empty source tree', () => {
    const files = walk(SRC_ROOT);
    expect(
      files.length,
      `No TypeScript sources found under ${SRC_ROOT}. A guard that finds nothing ` +
        `to inspect passes vacuously, so this is a broken guard rather than a ` +
        `clean run — check SRC_ROOT and EXCLUDED_DIRS before trusting a pass.`,
    ).toBeGreaterThan(0);
  });

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
