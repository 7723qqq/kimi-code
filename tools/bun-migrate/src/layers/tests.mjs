import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse, ts } from '../ast.mjs';
import { denyList, isDeniedFile, loadProjectOverrides } from '../capabilities.mjs';

const TEST_MODULES = new Set(['vitest', 'jest', '@jest/globals']);

/**
 * Names that `bun:test` also exports, so an import of them stays valid.
 *
 * `expect` is on this list and it matters: dropping it because vitest injected
 * it globally produces a file that references an undefined identifier under
 * `bun test`, where `expect` is a module export, not a global.
 */
const BUN_TEST_EXPORTS = new Set([
  'describe',
  'expect',
  'it',
  'test',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'jest',
]);

const FUNCTION_RENAMES = new Map([
  ['vi', new Map([['fn', 'mock']])],
  ['jest', new Map([['fn', 'mock']])],
]);

/**
 * Snapshot APIs whose semantics differ under `bun:test`, so a rewritten file
 * cannot be trusted to assert what it asserted before.
 *
 * Each entry was measured on Bun 1.4.4 against vitest on the same file. The point
 * is not that snapshots are unsupported — `bun:test` has them — it is that a
 * snapshot written by another runner is not the one Bun compares, and a mismatch
 * can pass instead of failing:
 *
 * - `describe` scoping. vitest keys an entry `outer > inner > works 1`; Bun keys
 *   the same test `outer inner works 1`. A vitest-written file therefore has no
 *   entry Bun recognises, so Bun appends a second one and passes. Measured: with
 *   the asserted value changed to `"TOTALLY-DIFFERENT"` under a vitest key, the
 *   run reported `snapshots: +1 added` and left both entries in the file. Under
 *   `CI=true` it fails instead, because Bun refuses to create snapshots there — so
 *   the same file passes locally and fails in CI.
 * - `toThrowErrorMatchingSnapshot`. vitest stores `[Error: boom]`, Bun stores
 *   `"boom"`, and Bun fails against the vitest form even when nothing changed. The
 *   inline variant agrees between the two, so only the file-backed one blocks.
 * - `toMatchFileSnapshot` is not on Bun's `expect` at all: calling it throws
 *   `TypeError: toMatchFileSnapshot is not a function`.
 * - `expect.addSnapshotSerializer` exists but throws `Not implemented`, so a file
 *   that registers one cannot run.
 *
 * `toMatchSnapshot` / `toMatchInlineSnapshot` with no `describe` around them and
 * no hint argument are compatible in both directions, so those files still
 * migrate.
 */
const SNAPSHOT_BLOCKERS = [
  {
    pattern: /\btoMatchFileSnapshot\s*\(/,
    reason: 'toMatchFileSnapshot does not exist on bun:test expect, so the call throws at run time',
  },
  {
    pattern: /\bexpect\s*\.\s*addSnapshotSerializer\s*\(/,
    reason: 'expect.addSnapshotSerializer throws "Not implemented" under bun:test',
  },
  {
    pattern: /\btoThrowErrorMatchingSnapshot\s*\(/,
    reason: 'vitest stores a thrown snapshot as [Error: msg] and bun compares against msg, so an unchanged test fails',
  },
];

/**
 * A `describe`/`suite` call, whose nesting changes a snapshot key.
 *
 * The check is deliberately conservative: a `describe` that turns out not to wrap
 * the snapshot costs the file a skip message, while a missed one silently turns a
 * failing assertion into a passing one.
 */
const DESCRIBE_CALL = /\b(?:describe|suite)\s*(?:\.\s*\w+\s*)?\(/;

/**
 * Whether a `toMatchSnapshot` call passes a hint argument.
 *
 * vitest keys a hinted snapshot `name: hint 1` and Bun keys it `name hint 1`, so a
 * vitest-written entry is never the one Bun compares. The argument is detected
 * positionally because the call may span lines: an opening parenthesis followed by
 * anything but a closing one on the same statement.
 */
function hasSnapshotHint(text) {
  const pattern = /\btoMatchSnapshot\s*\(([^)]*)\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1].trim().length > 0) return true;
  }
  return false;
}

/**
 * Why a snapshot assertion cannot be migrated by renaming the runner import.
 *
 * Returns every reason rather than the first, so one skip message names them all.
 * An empty list means the file's snapshot use is compatible and the rewrite may
 * proceed.
 */
export function snapshotBlockers(text) {
  const reasons = [];
  for (const blocker of SNAPSHOT_BLOCKERS) {
    if (blocker.pattern.test(text)) reasons.push(blocker.reason);
  }
  const usesFileSnapshot = /\btoMatchSnapshot\s*\(/.test(text);
  if (usesFileSnapshot && DESCRIBE_CALL.test(text)) {
    reasons.push(
      'a toMatchSnapshot call inside a describe block is keyed "outer > inner > name" by vitest and "outer inner name" by bun, so bun appends a new entry and the assertion passes instead of comparing',
    );
  }
  if (usesFileSnapshot && hasSnapshotHint(text)) {
    reasons.push(
      'toMatchSnapshot(hint) is keyed "name: hint" by vitest and "name hint" by bun, so the existing entry is not the one bun compares',
    );
  }
  return [...new Set(reasons)];
}

/**
 * Rewrite the `vi.fn()` / `jest.fn()` family into `bun:test`'s `mock()`.
 *
 * Only the constructor form is rewritten: `mock()` returns the same kind of
 * spy, and `vi.fn()` has no other meaning. `vi.spyOn`, `vi.mock` and the timer
 * helpers are left alone, because their `bun:test` equivalents take different
 * arguments and a text rewrite would change what the test asserts.
 */
function rewriteMockCalls(sourceFile, text, notes) {
  const edits = [];
  let rewritten = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const owner = node.expression.expression.text;
      const table = FUNCTION_RENAMES.get(owner);
      if (table) {
        const replacement = table.get(node.expression.name.text);
        if (replacement) {
          const callee = node.expression;
          edits.push({
            start: callee.expression.getStart(),
            end: callee.name.getEnd(),
            text: replacement,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (edits.length === 0) return { text, rewritten };
  let next = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  rewritten = edits.length;
  notes.push(`rewrote ${rewritten} vi.fn/jest.fn call(s) to mock()`);
  return { text: next, rewritten };
}

/**
 * Make sure every `bun:test` symbol the file now uses is actually imported.
 *
 * A rewrite that changes `vi.fn()` into `mock()` but leaves `mock` unimported
 * produces a file that fails at run time, which is worse than not rewriting it.
 *
 * The check has to ignore `object.method(...)` calls: `vi.mock('./x')` contains
 * the text `mock(` but refers to a property of `vi`, not to the imported
 * function. Counting it pulled `mock` into the import list while the call site
 * kept saying `vi.mock`, so the file was broken at both ends.
 */
function ensureMockImport(text, notes, canCreateImport) {
  const bareMockCall = /(^|[^.\w$])mock\s*\(/m;
  if (!bareMockCall.test(text)) return text;
  const importLine = /import\s*\{([^}]*)\}\s*from\s*['"]bun:test['"];/.exec(text);
  if (!importLine) {
    if (!canCreateImport) return text;
    notes.push('added a bun:test import for mock');
    return `import { mock } from 'bun:test';\n${text}`;
  }
  const names = importLine[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.some((name) => name === 'mock' || name.endsWith(' as mock'))) return text;
  names.push('mock');
  const rebuilt = `import { ${names.join(', ')} } from 'bun:test';`;
  notes.push('added mock to the bun:test import');
  return `${text.slice(0, importLine.index)}${rebuilt}${text.slice(importLine.index + importLine[0].length)}`;
}

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

function rewriteImports(sourceFile, text) {
  const edits = [];
  const notes = [];
  const importNames = new Map();
  const blockers = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!TEST_MODULES.has(specifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;

    /**
     * A type-only import and a default import cannot be carried over to
     * `bun:test` by renaming the specifier: the default binding has no
     * counterpart, and dropping a type import breaks every reference to the
     * type. Leaving the statement untouched is the only rewrite that keeps the
     * file compiling, and the note tells the reader it needs a decision.
     */
    if (clause.isTypeOnly) {
      blockers.push(`${statement.getText().split('\n')[0].trim()} is type-only and has no bun:test counterpart`);
      continue;
    }
    if (clause.name) {
      blockers.push(`a default import from '${specifier}' has no bun:test counterpart`);
      continue;
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      blockers.push(
        `a namespace import from '${specifier}' has no bun:test counterpart; rewrite it to named imports so each member can be checked`,
      );
      continue;
    }

    const kept = [];
    const dropped = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (BUN_TEST_EXPORTS.has(imported)) {
          kept.push(element.propertyName ? `${imported} as ${element.name.text}` : imported);
          importNames.set(element.name.text, imported);
        } else {
          dropped.push({ imported, local: element.name.text });
        }
      }
    }

    /**
     * A dropped name that is still used leaves the file broken, which is worse
     * than declining the rewrite. The exception is a name whose every use is a
     * call this layer knows how to rewrite — `vi.fn()` becomes `mock()`, so `vi`
     * disappears and the import can go. `vi.spyOn`, `vi.mock` and the timer
     * helpers have no drop-in equivalent, so a file using them is left alone and
     * reported rather than half-rewritten.
     */
    const unrewritable = dropped.filter((item) => hasUnrewritableUse(sourceFile, item.local, statement));
    if (unrewritable.length > 0) {
      const methods = unrewritable.map((item) => `${item.local}.${unrewritableMethod(sourceFile, item.local)}`);
      blockers.push(
        `${methods.join(', ')} is used but has no bun:test export, so this file was left alone`,
      );
      continue;
    }

    const replacement = kept.length > 0
      ? `import { ${[...new Set(kept)].join(', ')} } from 'bun:test';`
      : '';
    if (dropped.length > 0) {
      notes.push(`dropped adapter(s) bun:test does not export: ${[...new Set(dropped.map((item) => item.imported))].join(', ')}`);
    }
    edits.push({
      start: statement.getStart(),
      end: statement.getEnd(),
      text: replacement,
    });
  }
  if (blockers.length > 0) return { text, notes, blockers };
  if (edits.length === 0) return { text, notes };
  let next = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return { text: next, notes };
}

/**
 * Whether a local name is read anywhere outside the import statement that binds it.
 *
 * Traversal visits identifiers only, so a comment or a string literal that spells
 * the name does not count as a use.
 */
function noteTimerApi(sourceFile, notes) {
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === 'vi' || node.expression.expression.text === 'jest')
    ) {
      const method = node.expression.name.text;
      if (method === 'useFakeTimers') {
        notes.push('vi.useFakeTimers -> setSystemTime/advanceTimersByTime needs a manual rewrite');
      }
      if (method === 'mock' && node.arguments.length > 0) {
        const target = node.arguments[0];
        if (ts.isStringLiteral(target)) {
          notes.push('vi.mock(module) -> mock.module() needs a manual rewrite');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function resolvesNotToThrowArgument(node) {
  if (!ts.isCallExpression(node)) return;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  if (callee.name.text !== 'toThrow' && callee.name.text !== 'toThrowError') return;
  const notAccess = callee.expression;
  if (!ts.isPropertyAccessExpression(notAccess) || notAccess.name.text !== 'not') return;
  const resolvesAccess = notAccess.expression;
  if (!ts.isPropertyAccessExpression(resolvesAccess) || resolvesAccess.name.text !== 'resolves') return;
  const expectCall = resolvesAccess.expression;
  if (
    !ts.isCallExpression(expectCall) ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== 'expect' ||
    expectCall.arguments.length !== 1
  ) {
    return;
  }
  return expectCall.arguments[0];
}

/**
 * `await expect(promise).resolves.not.toThrow()` asserts that the promise
 * resolves. Vitest accepts the resolved value; `bun:test` treats it as the value
 * that was thrown and fails. The equivalent assertion is `await promise`.
 *
 * Only the awaited expression-statement form is rewritten: the resolved value is
 * not read there, so eliding the assertion cannot change what the test observes.
 * A resolved function would be invoked by Vitest's `toThrow`; that shape is rare
 * and is reported instead of guessed at.
 */
export function resolvesAssertionPlan(sourceFile) {
  const edits = [];
  const unsupported = [];
  const visit = (node) => {
    const argument = resolvesNotToThrowArgument(node);
    if (argument) {
      const awaited =
        node.parent &&
        ts.isAwaitExpression(node.parent) &&
        node.parent.parent &&
        ts.isExpressionStatement(node.parent.parent);
      if (awaited) {
        edits.push({ start: node.getStart(), end: node.getEnd(), text: argument.getText() });
      } else {
        unsupported.push(node.getText().slice(0, 80));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { edits, unsupported };
}

function applyTextEdits(text, edits) {
  let next = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}

function rewriteEach(sourceFile, notes) {
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === 'test' || callee.expression.text === 'it') &&
        callee.name.text === 'each'
      ) {
        notes.push('test.each needs a manual rewrite into a for...of loop');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * The first method name read off a local binding, for the skip message.
 *
 * `vi.useFakeTimers` is actionable; "vi is used" is not. The message has to name
 * the call that stopped the rewrite or the reader has to search for it.
 */
function unrewritableMethod(sourceFile, name) {
  let found = '?';
  const visit = (node) => {
    if (found !== '?') return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = node.name.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Whether a local name has a use this layer cannot rewrite away.
 *
 * Returns false only when every use of `name` is `name.fn(...)` — the one call
 * shape that becomes `mock()`. A bare reference (`const v = vi`), an unknown
 * method (`vi.spyOn`), or a property read all count as unrewritable, because
 * after the import is gone there is nothing to point them at.
 */
function hasUnrewritableUse(sourceFile, name, importStatement) {
  let unrewritable = false;
  const visit = (node) => {
    if (unrewritable) return;
    if (node === importStatement) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const isCallee =
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        FUNCTION_RENAMES.get(name)?.has(parent.name.text) === true &&
        parent.parent &&
        ts.isCallExpression(parent.parent);
      if (!isCallee) unrewritable = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return unrewritable;
}

export function applyTestLayer(project, journal) {
  if (!journal.enabled('tests')) return;
  const overrides = loadProjectOverrides(project.config);
  const deny = denyList(overrides);
  for (const file of project.files) {
    const text = journal.readFile(file) ?? readText(project, file);
    if (!text) continue;
    const esmTest = /from\s+['"](vitest|jest|@jest\/globals)['"]/.test(text);
    const cjsTest = /\brequire\s*\(\s*['"](vitest|jest|@jest\/globals)['"]\s*\)/.test(text);
    if (!esmTest && !cjsTest) continue;
    if (isDeniedFile(file, deny)) continue;
    if (overrides.portable) {
      journal.skip(
        file,
        'tests',
        'portable = true: bun:test is Bun-only, so the file keeps its current test runner',
      );
      continue;
    }
    if (!esmTest) {
      journal.skip(
        file,
        'tests',
        'a CommonJS require() of a test runner is not rewritten; convert the file to import syntax first',
      );
      continue;
    }

    /**
     * A file whose snapshot assertions mean something different under `bun:test`
     * is left alone, for the same reason a file using `vi.spyOn` is: the rewrite
     * would produce a test that still passes and no longer checks what it says.
     *
     * This runs before the import rewrite so the whole file stays byte-identical.
     * Reporting it and rewriting anyway was the previous behaviour — measured, a
     * snapshot file was rewritten and the assertion was left in place, so the
     * suite went green while comparing against entries Bun had just created.
     */
    const snapshotReasons = snapshotBlockers(text);
    if (snapshotReasons.length > 0) {
      journal.skip(
        file,
        'tests',
        `left alone: ${snapshotReasons.join('; ')}. Port the snapshots by hand, or delete __snapshots__ and regenerate with \`bun test --update-snapshots\``,
      );
      continue;
    }

    const sourceFile = parse(file, text);
    const notes = [];
    const imported = rewriteImports(sourceFile, text);
    if (imported.blockers && imported.blockers.length > 0) {
      for (const blocker of imported.blockers) journal.skip(file, 'tests', blocker);
      continue;
    }
    let next = imported.text;
    let working = imported.text !== text ? parse(file, next) : sourceFile;
    const resolves = resolvesAssertionPlan(working);
    if (resolves.unsupported.length > 0) {
      journal.skip(
        file,
        'tests',
        'expect(...).resolves.not.toThrow() is only rewritten when it is awaited as a statement; port this assertion by hand',
      );
      continue;
    }
    if (resolves.edits.length > 0) {
      next = applyTextEdits(next, resolves.edits);
      notes.push(
        `rewrote ${resolves.edits.length} expect(...).resolves.not.toThrow() assertion(s) to await the promise`,
      );
      working = parse(file, next);
    }
    const mocked = rewriteMockCalls(working, next, notes);
    next = mocked.text;
    next = ensureMockImport(next, notes, mocked.rewritten > 0);
    noteTimerApi(sourceFile, notes);
    rewriteEach(sourceFile, notes);
    if (next === text) {
      for (const note of [...imported.notes, ...notes]) journal.skip(file, 'tests', note);
      continue;
    }
    journal.set(
      file,
      next,
      'tests',
      ['vitest/jest -> bun:test', ...imported.notes, ...notes].join('; '),
      text,
    );
  }
}
