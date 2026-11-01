import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let tsModule;
function loadTs() {
  if (tsModule === undefined) tsModule = require('typescript-legacy');
  return tsModule;
}

let scriptKinds;
function scriptKindsMap() {
  if (scriptKinds === undefined) {
    const ts = loadTs();
    scriptKinds = new Map([
      ['.ts', ts.ScriptKind.TS],
      ['.tsx', ts.ScriptKind.TSX],
      ['.mts', ts.ScriptKind.TS],
      ['.cts', ts.ScriptKind.TS],
      ['.js', ts.ScriptKind.JS],
      ['.jsx', ts.ScriptKind.JSX],
      ['.mjs', ts.ScriptKind.JS],
      ['.cjs', ts.ScriptKind.JS],
    ]);
  }
  return scriptKinds;
}

/**
 * Loaded on first property access, not at import time.
 *
 * The CLI imports every layer; `revert` and config-only runs never parse a
 * source file, but the eager `require` here made every CLI process pay the
 * TypeScript startup cost. The layers only touch `ts.*` inside the functions
 * that parse.
 */
const ts = new Proxy(
  {},
  {
    get(_target, property) {
      return loadTs()[property];
    },
  },
);

export function parse(path, text) {
  const ts = loadTs();
  const extension = path.slice(path.lastIndexOf('.'));
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindsMap().get(extension) ?? ts.ScriptKind.TS,
  );
}

function moduleSpecifierOf(node) {
  if (!node.moduleSpecifier) return;
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

/**
 * Collect the local names a file binds to `node:` module exports.
 *
 * Both shapes matter: `import { readFile } from 'node:fs/promises'` binds
 * readFile, and `import * as fsp from 'node:fs/promises'` binds a namespace whose
 * member access reaches the same function. A name that appears in either map is
 * the real builtin; a same-named local wrapper (this repo has several) is not.
 */
/**
 * CommonJS bindings that reach a `node:` builtin.
 *
 * `require('node:module').findPackageJSON(x)` and
 * `const m = require('node:module'); m.findPackageJSON(x)` both resolve to the
 * same builtin, and the gap check has to see them. `collectNodeBindings` only
 * walks import declarations, which is correct for the rewrite layer (it does not
 * rewrite require) but wrong for a report about calls that will throw.
 *
 * Returns `{ namespaceByLocal, destructured }`: a local variable bound to the
 * whole module, and named members pulled out of it.
 */
export function collectRequireBindings(sourceFile) {
  const namespaceByLocal = new Map();
  const destructured = new Map();
  const declarationOf = (node) => {
    if (!node || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (!node.initializer || !ts.isCallExpression(node.initializer)) return;
    const call = node.initializer;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'require') return;
    const argument = call.arguments[0];
    if (!argument || !ts.isStringLiteral(argument) || !argument.text.startsWith('node:')) return;
    return { local: node.name.text, module: argument.text };
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const direct = declarationOf(node);
      if (direct) {
        namespaceByLocal.set(direct.local, direct.module);
        return;
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      ) {
        const call = node.initializer;
        if (ts.isIdentifier(call.expression) && call.expression.text === 'require') {
          const argument = call.arguments[0];
          if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('node:')) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const imported =
                element.propertyName && ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : element.name.text;
              destructured.set(element.name.text, { module: argument.text, imported });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { namespaceByLocal, destructured };
}

/**
 * The `node:` module a `require('node:...')` call names, if it is one.
 *
 * Only a literal argument counts. `require(name)` where `name` is a variable
 * resolves to something this tool cannot prove, so it is left alone rather than
 * guessed at.
 */
export function requiredNodeModuleOf(initializer) {
  if (!initializer || !ts.isCallExpression(initializer)) return;
  const callee = initializer.expression;
  if (!ts.isIdentifier(callee) || callee.text !== 'require') return;
  const argument = initializer.arguments[0];
  if (!argument || !ts.isStringLiteral(argument)) return;
  if (!argument.text.startsWith('node:')) return;
  return argument.text;
}

function enclosingVariableStatement(node) {
  let current = node.parent;
  while (current && !ts.isVariableStatement(current)) {
    if (ts.isSourceFile(current)) return;
    current = current.parent;
  }
  return current;
}

/**
 * Bind local names from `require('node:...')` into the same maps imports use.
 *
 * Both CommonJS shapes are collected: `const zlib = require('node:zlib')` binds a
 * namespace, and `const { gzipSync } = require('node:zlib')` binds the member.
 *
 * The `call` layer needs this because a CommonJS project reaching a builtin
 * through `require` is the same builtin as one reaching it through `import`. Before
 * it was collected, `collectNodeBindings` returned two empty maps and
 * `applySourceLayer` skipped the file outright, so a `require` call site was never
 * rewritten and never reported — the tool silently did nothing to it.
 *
 * `requires` carries the declaration and statement for each local so the rewrite
 * can remove the binding it made dead. A name reached through `require` has no
 * import statement to edit, which is why this needs its own list.
 */
export function collectNodeBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Map();
  const requires = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleSpecifierOf(statement);
    if (!specifier || !specifier.startsWith('node:')) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.set(clause.namedBindings.name.text, specifier);
        continue;
      }
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          named.set(element.name.text, { module: specifier, imported, element, statement });
        }
      }
    }
  }

  const visitRequires = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const module = requiredNodeModuleOf(node.initializer);
      if (module) {
        const statement = enclosingVariableStatement(node);
        if (ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, module);
          requires.set(node.name.text, {
            module,
            kind: 'namespace',
            declaration: node,
            statement,
          });
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            named.set(element.name.text, {
              module,
              imported,
              element,
              statement,
              declaration: node,
              via: 'require',
            });
            requires.set(element.name.text, {
              module,
              kind: 'member',
              declaration: node,
              statement,
              element,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visitRequires);
  };
  visitRequires(sourceFile);

  return { named, namespaces, requires };
}

/**
 * Resolve which node: builtin a call expression reaches, if any.
 *
 * Returns undefined for a same-named local function, which is the failure mode
 * a text replacement would silently get wrong. The `localName` is carried so the
 * caller can find and drop the binding it made dead without re-resolving.
 */
/**
 * Every local declaration in the file that could shadow an import binding.
 *
 * A call site whose identifier matches an import is only the builtin when no
 * local binding of the same name sits between the import and the call. The
 * TypeScript AST this tool parses carries no scope model, so the resolution in
 * `resolveBuiltinCall` is syntactic — which is correct for the common file, and
 * silently wrong for a file that declares `const gzipSync = fn` inside a
 * function after importing the builtin: measured, the rewrite changed which
 * function the call reached while the diff looked like a pure rename.
 *
 * The conservative answer is to collect every name the file declares locally —
 * functions, classes, enums, variables, and parameters, at any depth — and let
 * the layer refuse those call sites. A module-scope declaration of an import's
 * name cannot occur (the file would not parse), so the set only ever contains
 * function-scoped shadows, which legally hide the import from every call the
 * layer cannot prove is outside their scope.
 *
 * Two kinds of declaration are excluded because they *are* builtin bindings,
 * not shadows: a `const m = require('node:...')` declaration and each member it
 * destructures, provided no import binds the same local name to a *different*
 * module. When the modules disagree, the name is ambiguous — a call reached
 * through it may resolve to either builtin — so the name goes back into the set
 * and the rewrite is refused.
 *
 * The import bindings are collected here, from the import statements, rather
 * than read out of `collectNodeBindings`'s map: a file with both an import of
 * `readFile` and a `require('node:fs')` member of the same name leaves only the
 * require binding in that map — `visitRequires` overwrites on collision — so a
 * conflict check against the map compares the require to itself and never fires.
 */
export function collectShadowingNames(sourceFile) {
  const shadowed = new Set();
  const importedBy = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!statement.moduleSpecifier.text.startsWith('node:')) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) importedBy.set(clause.name.text, statement.moduleSpecifier.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        importedBy.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  const requireConflictsWithImport = (local, module) => {
    const imported = importedBy.get(local);
    return imported !== undefined && imported !== module;
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) shadowed.add(node.name.text);
    else if (ts.isClassDeclaration(node) && node.name) shadowed.add(node.name.text);
    else if (ts.isEnumDeclaration(node)) {
      if (node.name) shadowed.add(node.name.text);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) shadowed.add(node.name.text);
    else if (ts.isVariableDeclaration(node)) {
      const module = requiredNodeModuleOf(node.initializer);
      if (module) {
        if (ts.isIdentifier(node.name)) {
          if (requireConflictsWithImport(node.name.text, module)) shadowed.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (
              ts.isIdentifier(element.name) &&
              requireConflictsWithImport(element.name.text, module)
            ) {
              shadowed.add(element.name.text);
            }
          }
        }
        return;
      }
      if (ts.isIdentifier(node.name)) shadowed.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) shadowed.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return shadowed;
}

export function resolveBuiltinCall(call, bindings) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const binding = bindings.named.get(callee.text);
    if (!binding) return;
    return {
      module: binding.module,
      exportName: binding.imported,
      shape: 'named',
      binding,
      localName: callee.text,
    };
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const module = bindings.namespaces.get(callee.expression.text);
    if (!module) return;
    return {
      module,
      exportName: callee.name.text,
      shape: 'namespace',
      localName: callee.expression.text,
    };
  }
  return;
}

export function walkCalls(sourceFile, visit) {
  const walk = (node) => {
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Bind local names to the npm package they came from.
 *
 * A default import (`import yaml from 'yaml'`) and a named import
 * (`import { parse } from 'yaml'`) both count. The statement line is carried
 * because removing an import is a line operation, not a range operation: the
 * AST offsets shift once an earlier edit in the same file has been applied.
 */
export function collectPackageBindings(sourceFile) {
  const bindings = new Map();
  const statementStarts = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const packageName = statement.moduleSpecifier.text;
    if (
      packageName.startsWith('.') ||
      packageName.startsWith('node:') ||
      packageName.startsWith('bun:')
    )
      continue;
    const clause = statement.importClause;
    if (!clause) continue;
    /**
     * The line comes from the statement's own offset, not from searching the text for
     * its first line. `findIndex(line => line.includes(firstLine))` returns the first
     * match, so two multi-line imports that both start with `import {` — which is the
     * normal formatting for a wrapped clause — resolve to the same line. Measured:
     * `parse` and `stringify` imported on lines 0 and 3 both reported line 0, so
     * removing one would edit the other's statement.
     *
     * A start offset that is not unique would be the same bug through a different
     * door, so it is asserted rather than assumed.
     */
    const start = statement.getStart(sourceFile);
    if (statementStarts.has(start)) continue;
    statementStarts.add(start);
    const statementLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    if (clause.name) {
      bindings.set(clause.name.text, {
        package: packageName,
        imported: 'default',
        localName: clause.name.text,
        statementLine,
      });
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, {
        package: packageName,
        imported: '*',
        localName: clause.namedBindings.name.text,
        statementLine,
      });
      continue;
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        bindings.set(element.name.text, {
          package: packageName,
          imported,
          localName: element.name.text,
          statementLine,
        });
      }
    }
  }
  return bindings;
}

export { ts };
