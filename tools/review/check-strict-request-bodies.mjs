#!/usr/bin/env bun

// A route body schema that strips unknown keys silently is how a client's
// typo becomes a success response: the value never lands, nothing is logged,
// and the caller sees `code: 0`. This check enforces the rule the repository
// already follows in its own strict schemas (`node-sdk/src/config/schema.ts`
// `KimiConfigPatchSchema`, `kap-server/src/protocol/rest-session.ts`
// `exportSessionRequestSchema`): a schema at the request boundary must reject an
// unrecognized key rather than drop it.
//
// Scope is deliberately narrow — only the zod objects bound to a route's `body`
// and the objects they reference — because `z.object` is also the right tool for
// internally-produced shapes (tool args, manifests, engine config), where
// stripping has no foreign caller to mislead. A blanket rule would flag
// hundreds of those and bury the boundary cases.
//
// Two accepted forms:
//   z.object({...}).strict()          (legacy zod 4 spelling, still supported)
//   z.strictObject({...})             (the zod 4 recommended form)
//
// Usage: bun tools/review/check-strict-request-bodies.mjs
// Exit code: 0 when every route body is strict, 1 otherwise.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const ROUTES_DIR = join(REPO_ROOT, 'packages/kap-server/src/routes');

/// Bodies typed `unknown` are hand-validated by the route itself, and a body
/// that is not a schema reference is not this check's business.
const SKIP_BODIES = new Set(['unknown', 'req', 'opts', 'z']);

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/// Every `body: <Identifier>` reference a route declares.
export function routeBodySchemas() {
  const bodies = new Map();
  for (const file of walk(ROUTES_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bbody:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      if (SKIP_BODIES.has(name)) continue;
      if (!bodies.has(name)) bodies.set(name, []);
      bodies.get(name).push(relative(REPO_ROOT, file));
    }
  }
  return bodies;
}

/// Index just past the `;` that ends the declaration starting at `from`.
/// Brace counting rather than a lazy regex: these schemas contain
/// `.superRefine((value, ctx) => { ... })` blocks whose inner `;` would
/// otherwise terminate the match early.
function declarationEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return i;
  }
  return source.length;
}

/// Where a schema identifier is declared, and whether its declaration is strict.
function inspectSchema(name) {
  for (const root of ['packages/kap-server/src', 'packages/agent-core-v2/src']) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const source = readFileSync(file, 'utf8');
      const decl = new RegExp(String.raw`^export\s+const\s+${name}\s*(?::[^=]+)?=`, 'm').exec(
        source,
      );
      if (decl === null) continue;
      const eq = source.indexOf('=', decl.index);
      const body = source.slice(eq + 1, declarationEnd(source, eq + 1));
      const isStrict = /\.strict\(\)/.test(body) || /z\.strictObject\(/.test(body);
      // A `X.partial()` / `X.extend()` wrapper inherits nothing: report the
      // base so the fix lands where the shape is declared.
      const base = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.partial\(\))?\s*$/.exec(body.trim());
      return {
        file: relative(REPO_ROOT, file),
        strict: isStrict,
        base: base === null ? undefined : base[1],
      };
    }
  }
  return undefined;
}

export function findViolations() {
  const violations = [];
  for (const [name, files] of routeBodySchemas()) {
    const info = inspectSchema(name);
    if (info === undefined) continue;
    if (info.strict) continue;
    violations.push({ name, declaration: `${info.file}`, routes: files, base: info.base });
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('check-strict-request-bodies: OK');
    return 0;
  }
  for (const v of violations) {
    console.error(
      `${v.declaration}: route body schema "${v.name}" has no .strict() — an unrecognized key is dropped and the request still reports success (used by ${v.routes.join(', ')})${v.base === undefined ? '' : `; it derives from "${v.base}"`}`,
    );
  }
  console.error(
    `\ncheck-strict-request-bodies: ${violations.length} violation(s)\nAdd .strict() (or use z.strictObject) so a misspelled field is rejected with 40001 instead of silently ignored.`,
  );
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) process.exit(main());
