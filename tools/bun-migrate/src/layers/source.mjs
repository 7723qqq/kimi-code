import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectNodeBindings,
  collectShadowingNames,
  parse,
  requiredNodeModuleOf,
  resolveBuiltinCall,
  ts,
  walkCalls,
} from '../ast.mjs';
import {
  denyList,
  isDeniedFile,
  keepsNodePortable,
  loadProjectOverrides,
} from '../capabilities.mjs';
import { pairingFor, REPORT_ONLY } from '../pairings.mjs';

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

const helpers = {
  text(node) {
    return node ? node.getText() : 'undefined';
  },
};

export function applySourceLayer(project, journal) {
  if (!journal.enabled('source')) return;
  const overrides = loadProjectOverrides(project.config);
  if (!overrides.allowSource) {
    journal.note('source', 'auto-source = false in .bun-migrate.toml; no node: call was rewritten');
    return;
  }
  const deny = denyList(overrides);
  for (const file of project.files) {
    if (isDeniedFile(file, deny)) {
      continue;
    }
    const text = journal.readFile(file) ?? readText(project, file);
    if (!text) continue;
    if (!text.includes("'node:") && !text.includes('"node:')) continue;
    const sourceFile = parse(file, text);
    const bindings = collectNodeBindings(sourceFile);
    if (
      bindings.named.size === 0 &&
      bindings.namespaces.size === 0 &&
      bindings.requires.size === 0
    ) {
      continue;
    }

    const edits = [];
    const notes = [];
    const shadowed = collectShadowingNames(sourceFile);
    walkCalls(sourceFile, (call) => {
      const resolved = resolveBuiltinCall(call, bindings);
      if (!resolved) return;
      const pairing = pairingFor(resolved.module, resolved.exportName);
      if (!pairing) return;
      // The shadow check sits after the pairing lookup on purpose: a shadowed
      // call with no rewrite to make is not a finding, it is ordinary code.
      // Reporting it would flood the skip list with noise — measured on this
      // repository, 13 of 14 shadow hits name a function no pairing covers
      // (`resolve` from node:path, shadowed by Promise executors).
      if (shadowed.has(resolved.localName)) {
        notes.push(
          `${resolved.exportName}: a local declaration shadows the '${resolved.localName}' binding, so this call cannot be proven to reach the builtin`,
        );
        return;
      }
      if (!pairing) return;
      const site = { call, sourceFile, resolved };
      const reason = pairing.check(site, helpers);
      if (reason) {
        notes.push(`${pairing.id}: ${reason}`);
        return;
      }
      if (pairing.effect === REPORT_ONLY) {
        notes.push(`${pairing.id}: ${pairing.summary} (reported only)`);
        return;
      }
      if (overrides.portable && !keepsNodePortable(pairing)) {
        notes.push(
          `${pairing.id}: keeps only on Bun (${pairing.bunExpression}); skipped because portable = true`,
        );
        return;
      }
      const replacement = pairing.build(site, helpers);
      if (!replacement) {
        notes.push(`${pairing.id}: no automatic form is offered`);
        return;
      }
      /**
       * A rewrite replaces the call, and one that is already the operand of `await`
       * replaces the `await` too — otherwise `await Bun.x()` becomes
       * `await await Bun.x()`.
       *
       * There was a `needsAwait` branch here that prefixed `await` for rules that
       * needed one. No pairing ever set the flag, and it cannot be correct under the
       * `portable = true` contract anyway: every auto-applied rule emits a `Bun.*`
       * expression, so a rule that needed `await` would be async-only and could not
       * stay portable. Removed rather than kept as a hook nothing uses.
       */
      let start = call.getStart();
      const end = call.getEnd();
      if (call.parent && ts.isAwaitExpression(call.parent)) {
        start = call.parent.getStart();
      }
      edits.push({
        start,
        end,
        text: replacement,
        pairing,
        localName: resolved.binding?.element?.name?.text ?? resolved.localName,
      });
    });

    if (edits.length === 0) {
      for (const note of new Set(notes)) journal.skip(file, 'source', note);
      continue;
    }
    const outermost = dropNestedEdits(edits);
    if (outermost.length !== edits.length) {
      notes.push(
        `${edits.length - outermost.length} nested call(s) whose text survives inside the enclosing rewrite's replacement, which splices the original argument text through unchanged`,
      );
    }
    let next = text;
    for (const edit of outermost.toSorted((a, b) => b.start - a.start)) {
      next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
    }

    /**
     * A rewritten call leaves its `node:` binding behind as dead code. Removing it
     * is part of the rewrite, not a style pass: an unused named import keeps the
     * builtin in the module graph and makes the diff misleading about what the
     * file still depends on.
     *
     * Both binding forms are handled. An `import` statement is edited in place; a
     * `require(...)` declaration is not an import, so the same rewrite would leave
     * `const { createHash } = require('node:crypto')` sitting above code that no
     * longer calls it. That line was previously never touched, which meant a
     * CommonJS file kept a dead builtin reference in every migrated file.
     *
     * Only bindings whose every reference was rewritten are dropped; a name still
     * used elsewhere keeps its binding.
     */
    const rewrittenNames = new Set(outermost.map((edit) => edit.localName).filter(Boolean));
    if (rewrittenNames.size > 0) {
      next = dropUnusedNodeImports(next, text, rewrittenNames);
      next = dropUnusedNodeRequires(next, rewrittenNames);
    }

    if (next === text) {
      for (const note of new Set(notes)) journal.skip(file, 'source', note);
      continue;
    }
    const applied = [...new Set(outermost.map((edit) => edit.pairing.id))].join(', ');
    const skipped = [...new Set(notes)];
    journal.set(file, next, 'source', [`applied ${applied}`, ...skipped].join('; '), text);
  }
}

/**
 * Keep only edits whose source range does not sit inside another edit's range.
 *
 * `walkCalls` visits a call before its arguments, so `gzipSync(gunzipSync(buf))`
 * produces two edits: one for the whole outer call and one for the inner call,
 * whose range is inside the outer one. Applying both splices from the end of the
 * file backwards still corrupts the text, because the outer edit's replacement no
 * longer contains the inner call the second edit was computed against. Measured
 * output before this guard: `Bun.gzipSync(gunzipSync(buf))uf));`.
 *
 * The outer edit wins because its replacement is built from the original
 * argument text, which already carries whatever the inner call looked like. A
 * nested edit whose enclosing call was *not* rewritten does not appear here at
 * all, so a rewrite still reaches an inner call that nothing encloses.
 */
export function dropNestedEdits(edits) {
  const sorted = edits.toSorted((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const edit of sorted) {
    const covered = kept.some((outer) => edit.start >= outer.start && edit.end <= outer.end);
    if (!covered) kept.push(edit);
  }
  return kept;
}

/**
 * Drop `node:` named imports that no longer have a reference in the file.
 *
 * This is AST-driven rather than line-driven because the text forms are not
 * regular: a multi-line import spans several lines, an alias binds a local name
 * that differs from the imported one, and this project's own files put comments
 * and string literals around the identifiers. A regex that looks for the name
 * anywhere treats a comment mentioning `createHash` as a live reference and keeps
 * the import; a regex that edits a single line cannot touch a multi-line clause
 * at all. Both were measured against real files.
 *
 * The reference check excludes the import statements themselves, so the binding
 * being removed never counts as a use.
 *
 * A default or namespace import is never dropped: the rewrite does not change
 * those binding forms, and guessing would be worse than a stale line.
 */
export function dropUnusedNodeImports(rewrittenText, _originalText, candidates) {
  if (candidates.length === 0) return rewrittenText;
  const sourceFile = parse('rewritten.ts', rewrittenText);
  const wanted = new Set(candidates);

  const importRanges = [];
  const removable = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('node:')) continue;
    const clause = statement.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    if (clause.isTypeOnly) continue;
    importRanges.push([statement.getStart(), statement.getEnd()]);
    for (const element of clause.namedBindings.elements) {
      const local = element.name.text;
      if (!wanted.has(local)) continue;
      if (isReferencedOutsideImports(sourceFile, local, importRanges)) continue;
      removable.push({ statement, element, local });
    }
  }
  if (removable.length === 0) return rewrittenText;

  const byStatement = new Map();
  for (const item of removable) {
    if (!byStatement.has(item.statement)) byStatement.set(item.statement, []);
    byStatement.get(item.statement).push(item);
  }

  const edits = [];
  for (const [statement, items] of byStatement) {
    const elements = statement.importClause.namedBindings.elements;
    const dropping = new Set(items.map((item) => item.local));
    const remaining = elements.filter((element) => !dropping.has(element.name.text));
    if (remaining.length === 0) {
      if (statement.importClause.name) {
        const defaultName = statement.importClause.name;
        edits.push({
          start: defaultName.getEnd(),
          end: statement.importClause.namedBindings.getEnd(),
          text: '',
        });
        continue;
      }
      let end = statement.getEnd();
      while (rewrittenText[end] === '\n' || rewrittenText[end] === '\r') end += 1;
      edits.push({ start: statement.getStart(), end, text: '' });
      continue;
    }
    const braceStart = statement.importClause.namedBindings.getStart();
    const braceEnd = statement.importClause.namedBindings.getEnd();
    const rendered = remaining.map((element) => element.getText()).join(', ');
    edits.push({ start: braceStart, end: braceEnd, text: `{ ${rendered} }` });
  }

  let next = rewrittenText;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}

/**
 * Drop a `node:` binding that a `require(...)` declaration created and the
 * rewrite made dead.
 *
 * `dropUnusedNodeImports` only edits `import` statements, so a CommonJS file kept
 * `const { createHash } = require('node:crypto')` above code that no longer called
 * it. That is the same stale-dependency signal the import case exists to remove,
 * and before this function existed the tool rewrote the call and left the
 * `require` behind.
 *
 * Three shapes are handled, each verified by running the output:
 *
 * - `const { a, b } = require('node:m')` loses only the rewritten names
 * - `const { a } = require('node:m')` disappears entirely once nothing is left
 * - `const m = require('node:m')` disappears once no `m.x` reference remains
 *
 * A declaration that is not a plain `const`/`let`/`var` at statement level — a
 * destructuring assignment to an existing variable, or a require inside an
 * expression — is left alone. Those are not declarations this layer can remove
 * without changing what the file does.
 */
export function dropUnusedNodeRequires(rewrittenText, candidates) {
  if (candidates.length === 0) return rewrittenText;
  const sourceFile = parse('rewritten.ts', rewrittenText);
  const wanted = new Set(candidates);

  const declarationRanges = [];
  const candidatesForRemoval = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const module = requiredNodeModuleOf(declaration.initializer);
      if (!module) continue;
      declarationRanges.push([statement.getStart(), statement.getEnd()]);
      if (ts.isIdentifier(declaration.name)) {
        candidatesForRemoval.push({
          statement,
          declaration,
          kind: 'namespace',
          local: declaration.name.text,
        });
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        candidatesForRemoval.push({
          statement,
          declaration,
          kind: 'member',
          element,
          local: element.name.text,
        });
      }
    }
  }
  if (candidatesForRemoval.length === 0) return rewrittenText;

  const byDeclaration = new Map();
  for (const item of candidatesForRemoval) {
    if (!wanted.has(item.local)) continue;
    if (isReferencedOutsideImports(sourceFile, item.local, declarationRanges)) continue;
    if (!byDeclaration.has(item.declaration)) byDeclaration.set(item.declaration, []);
    byDeclaration.get(item.declaration).push(item);
  }
  if (byDeclaration.size === 0) return rewrittenText;

  const edits = [];
  for (const [declaration, items] of byDeclaration) {
    const statement = items[0].statement;
    const binding = items[0].kind;
    if (binding === 'namespace') {
      edits.push(wholeStatementEdit(rewrittenText, statement));
      continue;
    }
    const elements = declaration.name.elements;
    const dropping = new Set(items.map((item) => item.local));
    const remaining = elements.filter((element) => !dropping.has(element.name.text));
    if (remaining.length === 0) {
      edits.push(wholeStatementEdit(rewrittenText, statement));
      continue;
    }
    edits.push({
      start: declaration.name.getStart(),
      end: declaration.name.getEnd(),
      text: `{ ${remaining.map((element) => element.getText()).join(', ')} }`,
    });
  }

  let next = rewrittenText;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}

function wholeStatementEdit(text, statement) {
  let end = statement.getEnd();
  while (text[end] === '\n' || text[end] === '\r') end += 1;
  return { start: statement.getStart(), end, text: '' };
}
/**
 * Whether a local name is read anywhere outside the declarations that bind it.
 *
 * Traversal visits identifiers only, so a comment or a string literal that spells
 * the name does not count. A property access `object.name` is skipped because the
 * right side of a dot is not a reference to a local binding.
 */
function isReferencedOutsideImports(sourceFile, name, importRanges) {
  const inImport = (node) => {
    const start = node.getStart();
    return importRanges.some(([from, to]) => start >= from && start < to);
  };
  let referenced = false;
  const visit = (node) => {
    if (referenced) return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name && !inImport(node)) {
      const parent = node.parent;
      const isPropertyName =
        (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent && ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) referenced = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return referenced;
}
