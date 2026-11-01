import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectPackageBindings, collectShadowingNames, parse, ts, walkCalls } from '../ast.mjs';
import { denyList, isDeniedFile, loadProjectOverrides } from '../capabilities.mjs';
import { assessImport } from '../packages-map.mjs';

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

/**
 * The dependency set of the package that owns this file.
 *
 * Longest-prefix wins: `packages/a/src/x.ts` belongs to `packages/a`, and a
 * nested test folder with its own package.json takes precedence again. Returning
 * undefined means no nested manifest owns the file, so the root set applies.
 */
function ownerManifestOf(file, declaredByDirectory) {
  let best;
  for (const [directory, dependencies] of declaredByDirectory) {
    if (directory === '') continue;
    if (file === directory || file.startsWith(`${directory}/`)) {
      if (best === undefined || directory.length > best.directory.length) {
        best = { directory, dependencies };
      }
    }
  }
  return best?.dependencies;
}

/**
 * Rewrite calls into a Bun builtin when the whole import is verified.
 *
 * `Bun.markdown.html` and `Bun.stripANSI` are plain functions; `Bun.YAML` is an
 * object. Both shapes come from the replacement table, not from the call site,
 * so the builder stays one line per package.
 */
function buildReplacement(replacement, member, args) {
  const direct = replacement.memberExpressions?.[member];
  if (direct !== undefined) return `${direct}(${args})`;
  const target = replacement.bun;
  if (member === 'default') {
    return `${target}(${args})`;
  }
  const mapped = replacement.memberAliases?.[member] ?? member;
  return `${target}.${mapped}(${args})`;
}

export function applyPackageReplacementLayer(project, journal) {
  if (!journal.enabled('packages')) return;
  const overrides = loadProjectOverrides(project.config);
  const deny = denyList(overrides);
  const rootManifest = project.readJson('package.json');
  const rootDependencies = new Set([
    ...Object.keys(rootManifest?.dependencies ?? {}),
    ...Object.keys(rootManifest?.devDependencies ?? {}),
    ...Object.keys(rootManifest?.peerDependencies ?? {}),
  ]);
  const declaredByDirectory = project.declaredDependencies;

  const dependenciesFor = (file) => {
    const owner = ownerManifestOf(file, declaredByDirectory);
    if (owner) return owner;
    return rootDependencies;
  };

  const droppable = new Map();

  for (const file of project.files) {
    if (isDeniedFile(file, deny)) continue;
    const original = journal.readFile(file) ?? readText(project, file);
    if (!original) continue;
    if (!/\bfrom\s+['"][^'"]+['"]/.test(original)) continue;
    const dependencies = dependenciesFor(file);
    if (dependencies.size === 0) continue;

    let working = original;
    const applied = [];
    const editedNames = new Set();
    const reportedSkips = new Set();
    let changed = false;

    for (;;) {
      const sourceFile = parse(file, working);
      const bindings = collectPackageBindings(sourceFile);
      const shadowed = collectShadowingNames(sourceFile);
      let edit;

      for (const [localName, binding] of bindings) {
        if (!dependencies.has(binding.package)) continue;
        const skipKey = `${binding.package}#${localName}`;
        if (binding.imported === '*') {
          if (!reportedSkips.has(skipKey)) {
            reportedSkips.add(skipKey);
            journal.skip(
              file,
              'packages',
              `${binding.package}: a namespace import (import * as ...) is not rewritten automatically; import the members you use directly`,
            );
          }
          continue;
        }
        if (shadowed.has(localName)) {
          if (!reportedSkips.has(skipKey)) {
            reportedSkips.add(skipKey);
            journal.skip(
              file,
              'packages',
              `${binding.package}: a local declaration shadows the '${localName}' binding, so this call cannot be proven to reach the package import`,
            );
          }
          continue;
        }
        const assessment = assessImport(binding.package, [binding.imported]);
        if (!assessment) continue;
        if (!assessment.safe) {
          const missing =
            assessment.unverified.length > 0
              ? assessment.unverified.join(', ')
              : 'the package as a whole';
          journal.skip(
            file,
            'packages',
            `${binding.package}: ${missing} has no verified Bun equivalent — ${assessment.replacement.caveats}`,
          );
          continue;
        }
        if (overrides.portable) {
          const portableKey = `portable#${skipKey}`;
          if (!reportedSkips.has(portableKey)) {
            reportedSkips.add(portableKey);
            journal.skip(
              file,
              'packages',
              `${binding.package}: keeps only on Bun (${assessment.replacement.bun}); skipped because portable = true`,
            );
          }
          continue;
        }
        let site;
        walkCalls(sourceFile, (call) => {
          if (site) return;
          if (!ts.isIdentifier(call.expression)) return;
          if (call.expression.text !== localName) return;
          site = call;
        });
        if (!site) continue;
        const args = site.arguments.map((argument) => argument.getText()).join(', ');
        edit = {
          start: site.getStart(),
          end: site.getEnd(),
          text: buildReplacement(assessment.replacement, binding.imported, args),
          binding,
          replacement: assessment.replacement,
          localName,
        };
        break;
      }

      if (!edit) break;
      const previousWorking = working;
      working = `${working.slice(0, edit.start)}${edit.text}${working.slice(edit.end)}`;
      if (working === previousWorking) break;
      editedNames.add(edit.localName);
      applied.push(`${edit.binding.package} -> ${edit.replacement.bun}`);
      droppable.set(edit.binding.package, edit.replacement);
      changed = true;
    }

    if (changed && editedNames.size > 0) {
      /**
       * Group by the import statement each rewritten name came from, then remove one
       * statement per group. Grouping by line used to stand in for this; with the AST
       * path the line is no longer needed at all, and two wrapped imports of the same
       * package can no longer be mistaken for one.
       */
      const originalBindings = collectPackageBindings(parse(file, original));
      const byStatement = new Map();
      for (const name of editedNames) {
        const binding = originalBindings.get(name);
        if (!binding) continue;
        const key = `${binding.package}#${binding.statementLine}`;
        if (!byStatement.has(key)) {
          byStatement.set(key, { ...binding, localNames: new Set() });
        }
        byStatement.get(key).localNames.add(name);
        byStatement.get(key).localName ??= name;
      }
      for (const binding of byStatement.values()) {
        working = removeImport(working, file, binding);
      }
    }

    if (!changed) continue;
    journal.set(
      file,
      working,
      'packages',
      `rewrote ${applied.length} package call(s): ${[...new Set(applied)].join(', ')}`,
      original,
    );
  }

  for (const [packageName, replacement] of droppable) {
    journal.note(
      'packages',
      `${packageName} has no remaining importer in the scanned files; confirm before removing it from package.json in favour of ${replacement.bun}`,
    );
  }
}

/**
 * Drop the import statement that bound the replaced local name.
 *
 * Only the names that were rewritten are removed: an import that also binds other
 * symbols keeps them, so a file using `parse` and `stringify` from the same package
 * only loses the bindings that actually moved.
 *
 * This operates on the AST rather than on a line, because the line-regex version
 * only matched a single-line clause. Measured with the previous implementation, a
 * wrapped import —
 *
 *     import {
 *       parse,
 *     } from 'yaml';
 *
 * — produced no match at all, so the call was rewritten to `Bun.YAML.parse` and the
 * now-dead `import ... from 'yaml'` stayed behind. Nothing in the output said the
 * import was skipped, so the only signal was a reader noticing the leftover line.
 */
function removeImport(text, file, binding) {
  const sourceFile = parse(file, text);
  const clause = [...sourceFile.statements]
    .filter((statement) => ts.isImportDeclaration(statement))
    .map((statement) => ({ statement, importClause: statement.importClause }))
    .find(({ importClause }) => {
      if (!importClause) return false;
      const names = [];
      if (importClause.name) names.push(importClause.name.text);
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) names.push(element.name.text);
      }
      const removed = binding.localNames ?? new Set([binding.localName]);
      return names.includes(binding.localName) && [...removed].some((name) => names.includes(name));
    });
  if (!clause) return text;

  const { statement, importClause } = clause;
  const removed = binding.localNames ?? new Set([binding.localName]);
  const keepsDefault = importClause.name !== undefined && !removed.has(importClause.name.text);
  const named =
    importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)
      ? importClause.namedBindings.elements.filter((element) => !removed.has(element.name.text))
      : [];

  if (!keepsDefault && named.length === 0) {
    let end = statement.getEnd();
    while (text[end] === '\n' || text[end] === '\r') end += 1;
    return `${text.slice(0, statement.getStart())}${text.slice(end)}`;
  }

  const parts = [];
  if (keepsDefault) parts.push(importClause.name.getText());
  if (named.length > 0) parts.push(`{ ${named.map((element) => element.getText()).join(', ')} }`);
  const replacement = `import ${parts.join(', ')} from ${statement.moduleSpecifier.getText()};`;
  return `${text.slice(0, statement.getStart())}${replacement}${text.slice(statement.getEnd())}`;
}
