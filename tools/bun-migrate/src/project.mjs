import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SOURCE_SUFFIXES = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/**
 * Declaration files carry types only, so a rewrite has nothing to give them: their
 * calls are signatures, not executions. Collected before this was excluded, a
 * `src/api.d.ts` describing `gzipSync` was parsed and treated as a call site, which
 * produced a journal entry about a file whose contents never run.
 */
const DECLARATION_SUFFIX = '.d.ts';

/**
 * CI definition files the config layer rewrites.
 *
 * These were never collected, so `applyConfigLayer`'s workflow block iterated
 * `project.files` and found nothing: the "CI installs Bun instead of Node and
 * pnpm" step was dead code that no test could fail. They are collected separately
 * from source files because the source and tests layers must never parse them.
 */
const CI_SUFFIXES = new Set(['.yml', '.yaml']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-web',
  'dist-native',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'zig-out',
  'zig-cache',
  '.bun-migrate',
  '.tmp',
  'tmp',
  'vendor',
  'out',
  'target',
]);

const SKIP_PATH_PREFIXES = ['tools/bun-migrate/test/', 'tools/bun-migrate/src/'];

function readJson(path, { lenient = false } = {}) {
  if (!existsSync(path)) return;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (lenient) return;
    /**
     * "No readable package.json" is the right refusal for the root manifest, but
     * the two causes need different follow-ups: an absent file means the caller
     * picked the wrong directory, a syntax error means their manifest is broken
     * and a migration would be rewriting a project that does not build. The
     * position is included because "unexpected token" alone sends the reader
     * hunting for it.
     */
    const detail = error instanceof SyntaxError ? ` (${error.message})` : '';
    throw new Error(`cannot parse ${path}${detail}`, { cause: error });
  }
}

function walk(directory, root, out, budget, ciFiles = []) {
  if (out.length >= budget) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= budget) return;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absolute, root, out, budget, ciFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(DECLARATION_SUFFIX)) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    const rel = relative(root, absolute).split(sep).join('/');
    if (SKIP_PATH_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    if (rel.startsWith('.github/workflows/') && CI_SUFFIXES.has(extension)) {
      ciFiles.push(rel);
      continue;
    }
    if (!SOURCE_SUFFIXES.has(extension)) continue;
    out.push(rel);
  }
}

export function loadProject(rootOption) {
  const root = resolve(rootOption);
  const manifestPath = join(root, 'package.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw new Error(`no package.json at ${manifestPath}`);
  }
  const configPath = join(root, '.bun-migrate.toml');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const files = [];
  const ciFiles = [];
  walk(root, root, files, 200000, ciFiles);
  const declaredDependencies = collectDeclaredDependencies(root, files);
  const manifestDirectories = new Set(['']);
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      manifestDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  return {
    root,
    manifestPath,
    manifest,
    configPath,
    config,
    files: files.toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0),
    ciFiles: ciFiles.toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0),
    declaredDependencies,
    manifestDirectories: [...manifestDirectories].toSorted(),

    exists: (path) => existsSync(join(root, path)),
    absolute: (path) => join(root, path),
    read: (path) => readFileSync(join(root, path), 'utf8'),
    readJson: (path) => readJson(join(root, path)),
    /**
     * The file's bytes as they sit on disk, before any re-serialization.
     *
     * A manifest migration used to record `JSON.stringify(manifest, null, 2)`
     * as the journal's `before`, so `revert` restored a reformatted file
     * whenever the original was not written in exactly that shape — measured,
     * a single-line manifest came back five lines long and still showed as
     * modified. The journal entry has to carry the disk bytes.
     */
    rawText: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined),
    size: (path) => {
      try {
        return statSync(join(root, path)).size;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Dependency names declared by each nested package, keyed by its directory.
 *
 * A monorepo declares the same dependency once per package, so reading only the
 * root manifest skips every workspace member: `packages/x` with
 * `"smol-toml": "catalog:"` in its own package.json is invisible from the root.
 * The `catalog:` protocol counts as a declaration because Bun resolves it from
 * the root catalog.
 */
function collectDeclaredDependencies(root, files) {
  const byDirectory = new Map();
  const candidateDirectories = new Set(['']);
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      candidateDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  for (const directory of candidateDirectories) {
    const manifestPath = directory === '' ? 'package.json' : `${directory}/package.json`;
    /**
     * A broken nested manifest must not abort the whole migration. It only means
     * this directory's dependency set is unknown; falling back to the root set is
     * the conservative answer, and the file itself is left to its owner.
     */
    const parsed = readJson(join(root, manifestPath), { lenient: true });
    if (!parsed) continue;
    const names = new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
    ]);
    if (names.size > 0) byDirectory.set(directory, names);
  }
  return byDirectory;
}
