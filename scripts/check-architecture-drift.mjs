#!/usr/bin/env node
/**
 * Architecture drift detector.
 *
 * Reads architecture.json (the formal module tree + dependency rules) and
 * checks the actual codebase against it. Fail-closed: any violation is an
 * error that blocks the pre-commit gate and the CI `lint` job.
 *
 * Checks:
 *   A. Every module's source directory exists.
 *   B. Every module's deps are declared in the model (no undeclared targets),
 *      and the code agrees: no module imports a workspace package it did not
 *      declare, and no module reaches a workspace package that has no module
 *      entry in the model at all.
 *   C. Dependency direction follows layerOrder (app -> sdk -> engine -> shared).
 *   D. No circular dependencies.
 *   E. Every fingerprinted module still matches its source.
 *
 * Usage:
 *   node scripts/check-architecture-drift.mjs            # the gate (fail-closed)
 *   node scripts/check-architecture-drift.mjs --update   # refresh architecture.json
 *   node scripts/check-architecture-drift.mjs --help
 *
 * `--update` recomputes the E fingerprints and writes them back, then re-runs
 * the whole gate so the commit that refreshed the model is checked with it. It
 * refuses to touch a model that is missing or malformed: rewriting a broken
 * architecture.json from a broken read would turn a loud failure into a
 * silently wrong model. Run it in the same commit as the source change that
 * moved the fingerprint — that is the whole point of the gate.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, extname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const MODEL_PATH = resolve(root, 'architecture.json');

// The fingerprint input set is load-bearing: it is what the 16 stored hashes
// were computed from. Adding or removing an extension here silently invalidates
// every one of them, so it stays exactly as it was when the hashes were taken.
const FINGERPRINT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.rs', '.json', '.md'];
const FINGERPRINT_SKIP_DIRS = new Set(['node_modules', 'target', '.git']);

// Check B reads imports, not content hashes, so it may look at more syntaxes —
// but never at build output.
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.vue'];
const IMPORT_SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', 'coverage']);

// Static `from`/`import 'x'`, dynamic `import('x')` and CommonJS `require('x')`.
// Regex, not a parser: the gate must stay dependency-free (Node builtins only,
// like every other script under scripts/) and a missed specifier only makes the
// gate miss an edge, never invent one.
const IMPORT_PATTERNS = [
  /\bfrom\s*(['"])([^'"]+)\1/g, // import ... from 'x' / export ... from 'x'
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // await import('x')
  /\bimport\s+(['"])([^'"]+)\1/g, // import 'x'
  /\brequire(?:\.resolve)?\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // require('x')
];

/**
 * A `require` handle built by `createRequire`, which the patterns above cannot
 * see: the callee is whatever name the binding was given, so `require('x')`
 * never matches.
 *
 * `packages/kosong/src/native-tools.ts` is the live case — it does
 * `const requireNative = createRequire(import.meta.url)` and then
 * `requireNative('@moonshot-ai/kimi-agent/native')`, which made an
 * engine-to-engine edge invisible to this gate. Binding the name first and
 * deriving a pattern from it is what closes that hole without a parser.
 */
const CREATE_REQUIRE_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*createRequire\s*\(/g;

/** Call patterns for every `createRequire` handle bound in `text`. */
function createRequirePatterns(text) {
  const patterns = [];
  CREATE_REQUIRE_BINDING.lastIndex = 0;
  let match;
  while ((match = CREATE_REQUIRE_BINDING.exec(text)) !== null) {
    const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(
      new RegExp(`\\b${name}\\s*\\.?(?:resolve)?\\s*\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, 'g'),
    );
  }
  return patterns;
}

/**
 * Collect files under `dir` whose extension is in `extensions`.
 */
function walkFiles(dir, extensions, skipDirs, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walkFiles(full, extensions, skipDirs, out);
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative POSIX path, for evidence lines. */
function repoPath(rootDir, target) {
  return relative(rootDir, target).replaceAll(sep, '/');
}

/** True when `target` is `dir` itself or lives under it. */
function isInside(dir, target) {
  const rel = relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 1-based line number of `index` in `text`. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.codePointAt(i) === 10) line++;
  }
  return line;
}

/**
 * Blank out comments while preserving offsets and line numbers.
 *
 * Without this, a JSDoc `@example` reading `import { createI18n } from
 * '@moonshot-ai/i18n-shared/web'` is indistinguishable from a real import —
 * exactly the false positive a fail-closed gate must not produce.
 */
function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + ' '.repeat(line.length - lead.length));
}

/** Every import specifier in a source file, with its offset in the comment-free text. */
function extractImports(source) {
  const text = stripComments(source);
  const found = [];
  for (const pattern of [...IMPORT_PATTERNS, ...createRequirePatterns(text)]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push({ spec: match[2], index: match.index });
    }
  }
  return { text, found };
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function packageNameOfSpecifier(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The workspace package owning `dir`, found by walking up to the nearest
 * package.json. Returns null at the repo root or when there is none.
 */
function owningPackage(dir, rootDir) {
  let current = resolve(dir);
  while (isInside(rootDir, current) || current === rootDir) {
    const manifest = resolve(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name) return { dir: current, name: pkg.name, manifest: pkg };
      } catch {
        return null; // unparseable manifest: treat as "not a workspace package"
      }
    }
    if (current === rootDir) break;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Map every workspace package name to its directory, from the root
 * package.json `workspaces.packages` globs — the same membership the rest of
 * the toolchain uses, so a package the gate does not know about cannot hide
 * behind a second, narrower config.
 */
function readWorkspacePackages(rootDir) {
  const manifestPath = resolve(rootDir, 'package.json');
  if (!existsSync(manifestPath)) return new Map();
  let globs;
  try {
    globs = JSON.parse(readFileSync(manifestPath, 'utf8'))?.workspaces?.packages ?? [];
  } catch {
    return new Map();
  }

  const included = new Set();
  const excluded = new Set();
  for (const glob of globs) {
    const negated = glob.startsWith('!');
    const pattern = negated ? glob.slice(1) : glob;
    const matched = [];
    if (pattern.endsWith('/*')) {
      const base = resolve(rootDir, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(resolve(base, entry.name, 'package.json'))) {
          matched.push(`${pattern.slice(0, -2)}/${entry.name}`);
        }
      }
    } else if (existsSync(resolve(rootDir, pattern, 'package.json'))) {
      matched.push(pattern);
    }
    for (const dir of matched) (negated ? excluded : included).add(dir);
  }

  const byName = new Map();
  for (const dir of included) {
    if (excluded.has(dir)) continue;
    try {
      const pkg = JSON.parse(readFileSync(resolve(rootDir, dir, 'package.json'), 'utf8'));
      if (pkg.name) byName.set(pkg.name, dir);
    } catch {
      // A manifest we cannot read is not a dep edge we can assert on.
    }
  }
  return byName;
}

/** Every string leaf of a package.json `imports` target (string, array or condition object). */
function importTargetLeaves(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(importTargetLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(importTargetLeaves);
  return [];
}

/**
 * Resolve a `#/*` alias against the owning package's `imports` map: exact key
 * first, then the longest wildcard key. Returns null when nothing matches.
 */
function resolveImportAlias(spec, imports) {
  if (!imports) return null;
  if (imports[spec]) return importTargetLeaves(imports[spec]);
  let best = null;
  for (const key of Object.keys(imports)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, suffix, targets: importTargetLeaves(imports[key]) };
    }
  }
  if (!best) return null;
  const wildcard = spec.slice(best.prefix.length, spec.length - best.suffix.length);
  return best.targets.map((target) => target.replaceAll('*', wildcard));
}

/** SHA-256 (16 hex chars) of a module's sorted path+content fingerprint. */
function fingerprintOf(sourceDir) {
  // Sort by code unit rather than by locale: `localeCompare` orders
  // punctuation and case using the platform's collation tables, so two
  // machines can walk the same tree in a different order and hash a
  // different sequence of files.
  const files = walkFiles(sourceDir, FINGERPRINT_EXTENSIONS, FINGERPRINT_SKIP_DIRS).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const hash = createHash('sha256');
  for (const file of files) {
    // `relative` is platform-dependent — `sub\file.rs` on Windows, `sub/file.rs`
    // everywhere else — so hashing it raw would give every module a different
    // fingerprint per platform, and a value recorded on one could never match a
    // checkout on the other. Normalize to the forward slash the repo uses
    // everywhere, including `.gitattributes`.
    hash.update(relative(sourceDir, file).split(sep).join('/'));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Check an architecture model against the actual codebase. Returns diagnostics;
 * the caller decides how to report them. Exported for testing.
 */
export async function checkArchitecture(model, rootDir) {
  const diagnostics = [];
  const diag = (severity, code, message, subject, evidence) =>
    diagnostics.push({ severity, code, message, subject, evidence });

  // Check A: source directories exist
  for (const mod of model.modules) {
    const dir = resolve(rootDir, mod.source);
    if (!existsSync(dir)) {
      diag('error', 'structure/missing-source', `Module "${mod.id}" source directory does not exist`, mod.id, mod.source);
    }
  }

  // Check B: deps declared in the model
  const declaredIds = new Set(model.modules.map((m) => m.id));
  for (const mod of model.modules) {
    for (const dep of mod.deps ?? []) {
      if (!declaredIds.has(dep)) {
        diag('error', 'deps/undeclared-target', `Module "${mod.id}" depends on "${dep}" which is not declared in the model`, mod.id, dep);
      }
    }
  }

  // Check B (code half): the declared deps are the *only* workspace edges the
  // module has. Model-side validation alone cannot see an import, so a module
  // that quietly started importing another workspace package passed the gate
  // indefinitely — the deps list stayed true while the code stopped matching it.
  const workspace = readWorkspacePackages(rootDir);
  const moduleIdByPackage = new Map();
  for (const mod of model.modules) {
    const owner = owningPackage(resolve(rootDir, mod.source), rootDir);
    if (owner) moduleIdByPackage.set(owner.name, mod.id);
  }

  // A declared edge is a *hard* dependency. Some edges are deliberately soft —
  // an optional native module reached through a try/catch require, with a pure-JS
  // fallback — and declaring those in `deps` would be a lie the moment the
  // fallback path is the one that runs. `exemptions` records such an edge with
  // its reason; the gate still reports it, but as a warning, so it stays visible
  // instead of being either an unexplained error or silently dropped.
  /**
   * Key an `exemptions` entry by its two module ids. The separator is a NUL
   * because a module id may contain a space and this key is built by
   * concatenation — writing the separator in one place is what keeps the
   * lookup from silently missing after a refactor.
   */
  const EXEMPTION_SEP = '\u0000';
  const exemptionKey = (from, to) => `${from}${EXEMPTION_SEP}${to}`;

  const exemptions = new Map();
  for (const ex of model.exemptions ?? []) {
    if (typeof ex?.from === 'string' && typeof ex?.to === 'string') {
      exemptions.set(exemptionKey(ex.from, ex.to), str(ex.reason));
    }
  }

  /**
   * Emit the collected `deps/*` violations for one module.
   *
   * A declared soft edge — an optional native module behind a try/catch
   * require, with a pure-JS fallback — must not be declared in `deps`, or the
   * model lies whenever the fallback path is the one that runs. `exemptions`
   * records it; the gate keeps it visible as a warning rather than dropping it
   * or making it an unexplained error.
   */
  function reportDepViolations(violations) {
    for (const violation of violations.values()) {
      const more =
        violation.sites > 0 ? ` (+${violation.sites} more site${violation.sites === 1 ? '' : 's'})` : '';
      const exemption = exemptions.get(exemptionKey(violation.subject, violation.target));
      if (exemption !== undefined) {
        diag(
          'warning',
          violation.code,
          `${violation.message} — exempted in architecture.json as a soft dependency`,
          violation.subject,
          `${violation.evidence}${more}; ${exemption}`,
        );
        continue;
      }
      diag('error', violation.code, violation.message, violation.subject, `${violation.evidence}${more}`);
    }
  }

  for (const mod of model.modules) {
    const dir = resolve(rootDir, mod.source);
    const declared = new Set(mod.deps ?? []);
    const owner = owningPackage(dir, rootDir);
    const imports = owner?.manifest?.imports;
    /** @type {Map<string, {code: string, message: string, evidence: string, subject: string, sites: number}>} */
    const violations = new Map();

    // Check B (manifest half), deliberately **before** the source-dir guard and
    // independent of it: a `workspace:^` entry in `dependencies` is a build edge
    // whether or not the module's source directory is on disk, and a module
    // whose sources moved must not stop being checked.
    //
    // The source walk below only sees an edge the code spells out. Kept separate
    // from that walk on purpose: a soft runtime `require` is a *code* property
    // and can be exempted, whereas a `workspace:^` entry is a build property and
    // is not soft. Reporting it here keeps that distinction visible.
    if (owner?.manifest) {
      const manifestDeps = {
        ...owner.manifest.dependencies,
        ...owner.manifest.optionalDependencies,
      };
      for (const [name, range] of Object.entries(manifestDeps)) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
        if (name === owner.name) continue;
        const targetId = moduleIdByPackage.get(name);
        if (targetId && declared.has(targetId)) continue; // declared, fine
        const key = targetId ? `module:${targetId}` : `package:${name}`;
        if (violations.has(key)) continue; // the code half already named it
        violations.set(key, {
          code: targetId ? 'deps/undeclared-manifest' : 'deps/unmodeled-manifest',
          target: targetId ?? name,
          message: targetId
            ? `Module "${mod.id}" declares a workspace dependency on "${name}" (module "${targetId}") without declaring it in deps`
            : `Module "${mod.id}" declares a workspace dependency on "${name}" (${workspace.get(name)}) which has no module entry in the model`,
          subject: mod.id,
          evidence: `${repoPath(rootDir, resolve(owner.dir, 'package.json'))} "${name}": "${range}"`,
          sites: 0,
        });
      }
    }

    if (!existsSync(dir)) {
      reportDepViolations(violations);
      continue; // already reported in Check A
    }

    for (const file of walkFiles(dir, IMPORT_EXTENSIONS, IMPORT_SKIP_DIRS)) {
      const source = readFileSync(file, 'utf8');
      const { text, found } = extractImports(source);
      if (found.length === 0) continue;
      const where = repoPath(rootDir, file);

      for (const { spec, index } of found) {
        const at = `${where}:${lineAt(text, index)}`;

        // `#/x` is this repo's intra-package alias convention (the owning
        // package's own `imports` map), not a package edge. It only becomes a
        // violation when the map sends it outside the declared source root —
        // an alias is otherwise a boundary-crossing hole in Check A.
        if (spec.startsWith('#')) {
          const targets = resolveImportAlias(spec, imports);
          if (!targets) {
            if (!violations.has(`alias-unmapped:${spec}`)) {
              violations.set(`alias-unmapped:${spec}`, {
                code: 'deps/unmapped-alias',
                message: `Module "${mod.id}" imports alias "${spec}" which the owning package's "imports" map does not resolve`,
                subject: mod.id,
                evidence: `${at} "${spec}"`,
                sites: 0,
              });
            }
            continue;
          }
          const escaped = targets.filter((target) => !isInside(dir, resolve(owner.dir, target)));
          if (escaped.length > 0 && !violations.has('alias-escape')) {
            violations.set('alias-escape', {
              code: 'deps/alias-escape',
              message: `Module "${mod.id}" uses alias "${spec}" which resolves outside its declared source root`,
              subject: mod.id,
              evidence: `${at} -> ${escaped[0].replaceAll(sep, '/')}`,
              sites: 0,
            });
          }
          continue;
        }

        // Relative, absolute and node: specifiers are not package edges.
        if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) continue;

        const name = packageNameOfSpecifier(spec);
        const packageDir = workspace.get(name);
        if (!packageDir) continue; // external npm package
        if (name === owner?.name) continue; // self-reference / own subpath

        const targetId = moduleIdByPackage.get(name);
        if (targetId && declared.has(targetId)) continue; // declared, fine

        const key = targetId ? `module:${targetId}` : `package:${name}`;
        const existing = violations.get(key);
        if (existing) {
          existing.sites++;
          continue;
        }
        violations.set(key, {
          code: targetId ? 'deps/undeclared-import' : 'deps/unmodeled-import',
          target: targetId ?? name,
          message: targetId
            ? `Module "${mod.id}" imports workspace package "${name}" (module "${targetId}") without declaring it in deps`
            : `Module "${mod.id}" imports workspace package "${name}" (${packageDir}) which has no module entry in the model`,
          subject: mod.id,
          evidence: `${at} "${spec}"`,
          sites: 0,
        });
      }
    }

    // Check B (manifest half). The walk above reads source, so it can only see
    // an edge the code spells out. A `workspace:^` entry in the manifest is a
    // *build* edge whether or not any file imports it — and the script never
    // opened `dependencies` at all, so a package could take a hard dependency
    // on a workspace sibling without the model noticing. That is how
    // `packages/kosong` ended up depending on `@moonshot-ai/kimi-agent` in its
    // manifest while `architecture.json` declared no such edge.
    //
    // The code half and this half are kept separate on purpose: a soft runtime
    // `require` is a *code* property and can be exempted, whereas a
    // `workspace:^` entry in `dependencies` is a build property and is not
    // soft. Reporting it here keeps that distinction visible.
    reportDepViolations(violations);
  }

  // Check C: dependency direction follows layerOrder
  const layerIndex = new Map(model.rules.layerOrder.map((l, i) => [l, i]));
  const layerOf = new Map(model.modules.map((m) => [m.id, m.layer]));

  /** Coerce a layer value to string for safe template interpolation. */
  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  for (const mod of model.modules) {
    const fromLayer = layerOf.get(mod.id);
    if (fromLayer === undefined) continue;
    const fromIdx = layerIndex.get(fromLayer);
    for (const dep of mod.deps ?? []) {
      const toLayer = layerOf.get(dep);
      if (toLayer === undefined) continue;
      const toIdx = layerIndex.get(toLayer);
      if (fromIdx === undefined || toIdx === undefined) continue;
      if (toIdx < fromIdx) {
        const rule = model.rules.forbid.find((f) => f.from === fromLayer && f.to === toLayer);
        const reason = rule?.reason ?? `${str(fromLayer)} must not depend on ${str(toLayer)}`;
        diag('error', 'deps/layer-violation', `Module "${mod.id}" (${str(fromLayer)}) depends on "${dep}" (${str(toLayer)}), violating layer order`, mod.id, reason);
      }
    }
  }

  // Check D: no circular dependencies
  function hasCycle() {
    const state = new Map();
    const path = [];
    function visit(id) {
      const s = state.get(id) ?? 0;
      if (s === 1) return path.slice(path.indexOf(id)).concat(id);
      if (s === 2) return null;
      state.set(id, 1);
      path.push(id);
      const mod = model.modules.find((m) => m.id === id);
      for (const dep of mod?.deps ?? []) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
      path.pop();
      state.set(id, 2);
      return null;
    }
    for (const mod of model.modules) {
      const cycle = visit(mod.id);
      if (cycle) return cycle;
    }
    return null;
  }
  const cycle = hasCycle();
  if (cycle) diag('error', 'deps/cycle', `Circular dependency detected: ${cycle.join(' -> ')}`, cycle[0], cycle.join(' -> '));

  // ── Check E: fingerprint drift ────────────────────────────────────────────
  // Each module's source files are fingerprinted (SHA-256 of sorted path+content).
  // If the code changed but the stored fingerprint didn't, the architecture model
  // is stale — report drift so the model is refreshed before proceeding.
  for (const mod of model.modules) {
    if (!mod.fingerprint) continue;
    const dir = resolve(rootDir, mod.source);
    if (!existsSync(dir)) continue; // already reported in Check A
    const current = fingerprintOf(dir);
    if (current !== mod.fingerprint) {
      diag('error', 'drift/fingerprint', `Module "${mod.id}" source changed but architecture model fingerprint is stale`, mod.id, `stored=${mod.fingerprint} current=${current}`);
    }
  }

  return diagnostics;
}

// ── Model loading / updating ───────────────────────────────────────────────

/** A precondition failure: bad usage, or a model we refuse to rewrite. */
class ModelError extends Error {}

/**
 * Read architecture.json and prove it is a model this script can reason about.
 * `--update` rewrites the file, so anything it cannot fully understand is a
 * hard stop rather than a model it quietly normalises into a wrong shape.
 */
function loadModel(modelPath, rootDir) {
  const label = repoPath(rootDir, modelPath);
  if (!existsSync(modelPath)) {
    throw new ModelError(`${label} does not exist — the gate has nothing to check and --update will not create one.`);
  }
  let model;
  try {
    model = JSON.parse(readFileSync(modelPath, 'utf8'));
  } catch (error) {
    throw new ModelError(`${label} is not valid JSON: ${error.message}`);
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new ModelError(`${label} is not a JSON object`);
  }
  if (!Array.isArray(model.modules) || model.modules.length === 0) {
    throw new ModelError(`${label} has no "modules" array — refusing to write a model that would declare no architecture`);
  }
  const ids = new Set();
  for (const [index, mod] of model.modules.entries()) {
    if (!mod || typeof mod !== 'object' || typeof mod.id !== 'string' || mod.id === '') {
      throw new ModelError(`${label} modules[${index}] has no string "id"`);
    }
    if (typeof mod.source !== 'string' || mod.source === '') {
      throw new ModelError(`${label} module "${mod.id}" has no string "source"`);
    }
    if (ids.has(mod.id)) throw new ModelError(`${label} declares module "${mod.id}" twice`);
    ids.add(mod.id);
  }
  if (!model.rules || typeof model.rules !== 'object' || !Array.isArray(model.rules.layerOrder)) {
    throw new ModelError(`${label} has no "rules.layerOrder" array — Check C could not run`);
  }
  return model;
}

/**
 * Recompute every module's fingerprint. Returns the per-module changes so the
 * caller can report them. A missing source directory is a hard stop: recording
 * a fingerprint for a directory that is not there would bless a broken model.
 */
function refreshFingerprints(model, rootDir) {
  const changes = [];
  for (const mod of model.modules) {
    const dir = resolve(rootDir, mod.source);
    if (!existsSync(dir)) {
      throw new ModelError(`module "${mod.id}" source directory does not exist: ${mod.source} — refusing to record a fingerprint for it`);
    }
    const current = fingerprintOf(dir);
    if (current === mod.fingerprint) continue;
    changes.push({ id: mod.id, was: mod.fingerprint, now: current, added: !mod.fingerprint });
    mod.fingerprint = current;
  }
  return changes;
}

const USAGE = `Usage: node scripts/check-architecture-drift.mjs [--update] [--help]

  (no flag)  Check architecture.json against the codebase. Fail-closed:
             any error exits 1.
  --update   Recompute the stored fingerprints, write architecture.json back,
             then re-run the full gate. Refuses to run on a missing or
             malformed model. Run it in the same commit as the source change.
  --help     This message.`;

function reportDiagnostics(diagnostics, model) {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  for (const d of diagnostics) {
    const prefix = d.severity === 'error' ? '✗' : '⚠';
    console.log(`${prefix} [${d.code}] ${d.message}`);
    if (d.evidence) console.log(`    subject: ${d.subject}  evidence: ${d.evidence}`);
  }

  if (errors.length > 0) {
    console.log(`\n✗ Architecture check failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
    return 1;
  }
  console.log(`\n✓ Architecture check passed: ${model.modules.length} modules, ${warnings.length} warning(s)`);
  return 0;
}

// ── Main block (runs when executed directly) ────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const known = new Set(['--update', '--write', '--help', '-h']);
  const unknown = args.filter((a) => !known.has(a));

  if (unknown.length > 0) {
    console.error(`check-architecture-drift: unknown argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const updateMode = args.includes('--update') || args.includes('--write');
  let model;
  try {
    model = loadModel(MODEL_PATH, root);
    if (updateMode) {
      const changes = refreshFingerprints(model, root);
      if (changes.length === 0) {
        console.log('✓ architecture.json fingerprints already up to date (no write)');
      } else {
        // 2-space indent + trailing newline, matching the file as committed.
        writeFileSync(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`);
        console.log(`✓ architecture.json updated: ${changes.length} fingerprint(s) refreshed`);
        for (const change of changes) {
          const was = change.added ? '(none)' : change.was;
          console.log(`    ${change.id}: ${was} -> ${change.now}`);
        }
        console.log('    review the diff: a fingerprint moves only when its module\'s source did.');
      }
    }
  } catch (error) {
    if (error instanceof ModelError) {
      console.error(`✗ check-architecture-drift: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const diagnostics = await checkArchitecture(model, root);
  process.exit(reportDiagnostics(diagnostics, model));
}
