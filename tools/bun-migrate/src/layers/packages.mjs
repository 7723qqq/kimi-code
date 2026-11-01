import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { parse, ts } from '../ast.mjs';
import { denyList, isDeniedFile, loadProjectOverrides } from '../capabilities.mjs';
import { mergeBunfig } from './config.mjs';

/**
 * Carry the parts of a vitest config that `bun:test` can honour into `bunfig.toml`.
 *
 * Deleting `vitest.config.ts` outright loses `setupFiles`, `coverage`, `globals`
 * and the `jsdom` environment with one sentence saying bun:test needs no config.
 * That is false: `bun:test` reads a `[test]` table from `bunfig.toml`, including
 * `preload` (the setupFiles equivalent) and `coverage`. A migration that drops a
 * setup file makes tests fail on a missing global, which is exactly the kind of
 * breakage this tool exists to avoid.
 *
 * Text matching rather than evaluating the config: the file is TypeScript with
 * arbitrary imports, and executing a build config during a migration is not
 * something a rewrite tool should do. Anything not recognised is listed as
 * unported so the reader knows what is on them.
 *
 * `testTimeout` and `maxWorkers` are migrated rather than reported, because both
 * have a verified equivalent and a test suite that silently loses its timeout or
 * its worker count behaves differently without saying so. The measurements behind
 * those two are on `timeoutPreload` below.
 */
function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return;
}

/**
 * Top-level keys of the `test` object literal, read from the TypeScript AST.
 *
 * A regex over the file cannot tell `exclude` in the test config from `exclude`
 * inside `resolve.alias` or a comment. Those keys used to disappear together with
 * the deleted config and no journal line named them, which is the silent loss this
 * list exists to prevent.
 */
function testSettingKeys(text) {
  const sourceFile = parse('vitest.config.ts', text);
  let object;
  const visit = (node) => {
    if (object) return;
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'test' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      object = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!object) return;
  const keys = [];
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      keys.push(propertyName(property.name) ?? '<computed>');
    } else if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
    } else if (ts.isMethodDeclaration(property)) {
      keys.push(propertyName(property.name) ?? '<computed>');
    } else if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      keys.push(propertyName(property.name) ?? '<computed>');
    } else if (ts.isSpreadAssignment(property)) {
      keys.push('<spread>');
    }
  }
  return keys;
}

const HANDLED_TEST_KEYS = new Set([
  'setupFiles',
  'testTimeout',
  'hookTimeout',
  'coverage',
  'environment',
  'globals',
  'alias',
  'maxWorkers',
  'pool',
  'minWorkers',
]);

export function portVitestConfig(text) {
  const settings = [];
  const notes = [];
  const unported = [];
  const files = [];
  let parallel;
  let timeoutValue;

  const preload =
    /setupFiles\s*:\s*\[([^\]]*)\]/.exec(text) ?? /setupFiles\s*:\s*(['"][^'"]+['"])/.exec(text);
  const preloadEntries = [];
  if (preload) {
    for (const match of preload[1].matchAll(/['"]([^'"]+)['"]/g)) preloadEntries.push(match[1]);
    if (preloadEntries.length > 0) notes.push(`setupFiles -> preload (${preloadEntries.length})`);
  }

  const testTimeout = numericSetting(text, 'testTimeout');
  const hookTimeout = numericSetting(text, 'hookTimeout');

  /**
   * `bunfig.toml` has no timeout key: `[test] timeout = 50` is accepted and
   * ignored, measured against Bun 1.4.4 — a 300 ms test still passed. What does
   * work is `setDefaultTimeout(ms)` from `bun:test`, loaded through `preload`.
   * Measured: a 400 ms test fails with "this test timed out after 100ms", and a
   * slow `beforeEach` fails with "a beforeEach/afterEach hook timed out".
   *
   * Bun applies one default to both tests and hooks, so `testTimeout` and
   * `hookTimeout` can only be carried when they agree. When they disagree, carrying
   * one would silently change the other, so both are reported.
   */
  if (testTimeout !== undefined && hookTimeout !== undefined && testTimeout !== hookTimeout) {
    unported.push(
      `testTimeout: ${testTimeout} and hookTimeout: ${hookTimeout} differ, and bun:test has one default for tests and hooks — pick one and call setDefaultTimeout in a preload`,
    );
  } else if (testTimeout !== undefined || hookTimeout !== undefined) {
    const timeout = testTimeout ?? hookTimeout;
    timeoutValue = timeout;
    const name = TIMEOUT_PRELOAD;
    files.push({
      path: name,
      content: [
        "import { setDefaultTimeout } from 'bun:test';",
        '',
        `setDefaultTimeout(${timeout});`,
        '',
      ].join('\n'),
    });
    preloadEntries.push(`./${name}`);
    notes.push(`testTimeout/hookTimeout -> setDefaultTimeout(${timeout}) in ${name} via preload`);
  }

  if (preloadEntries.length > 0) {
    settings.push({
      table: 'test',
      key: 'preload',
      line: `preload = [${preloadEntries.map((entry) => `"${entry}"`).join(', ')}]`,
    });
  }

  if (/coverage\s*:\s*\{/.test(text)) {
    settings.push({ table: 'test', key: 'coverage', line: 'coverage = true' });
    notes.push('coverage -> coverage');
    if (/\b(?:thresholds|reporter|reportsDirectory|include|exclude)\s*:/.test(text)) {
      unported.push(
        'coverage options beyond enabling (thresholds, reporter, reportsDirectory) are not ported',
      );
    }
  }

  if (/environment\s*:\s*['"]jsdom['"]/.test(text)) {
    unported.push(
      'environment: jsdom (bun:test runs DOM tests without a jsdom global; use happy-dom preload)',
    );
  } else if (/environment\s*:\s*['"]happy-dom['"]/.test(text)) {
    unported.push('environment: happy-dom (register it as a preload instead)');
  }

  if (/globals\s*:\s*true/.test(text)) {
    unported.push('globals: true (bun:test always exposes describe/it/expect)');
  }

  if (/alias\s*:\s*\{/.test(text)) {
    unported.push('resolve.alias (use tsconfig paths; bun:test does not read this config)');
  }

  /**
   * `maxWorkers` is a real migration, not a report: `bun test --parallel=N` runs
   * test files across N worker processes. Measured on four files that each sleep
   * 500 ms, `bun test` took 2.2 s and `bun test --parallel=4` took 1.0 s, so the
   * flag is what actually restores the concurrency the config asked for. The caller
   * appends it to the test script, because `bunfig.toml` cannot express it — measured,
   * `[test] parallel = 4` is accepted and has no effect.
   */
  const maxWorkers = numericSetting(text, 'maxWorkers');
  if (maxWorkers !== undefined) {
    parallel = maxWorkers;
    notes.push(`maxWorkers: ${maxWorkers} -> bun test --parallel=${maxWorkers} in the test script`);
  }

  if (/\bpool\s*:/.test(text)) {
    unported.push(
      'pool (vitest isolation model has no bun equivalent; --parallel uses worker processes and implies --isolate)',
    );
  }

  if (/\bminWorkers\s*:/.test(text)) {
    unported.push('minWorkers (bun has no lower bound; --parallel sets the worker count directly)');
  }

  const keys = testSettingKeys(text);
  if (keys !== undefined) {
    const present = new Set(keys);
    for (const key of keys) {
      if (HANDLED_TEST_KEYS.has(key)) continue;
      unported.push(`${key}: not ported (no verified bun:test equivalent)`);
    }
    if (present.has('setupFiles') && !preload) {
      unported.push('setupFiles: the value is not a literal array or string, so it was not ported');
    }
    if (present.has('testTimeout') && testTimeout === undefined) {
      unported.push('testTimeout: the value is not a literal number, so it was not ported');
    }
    if (present.has('hookTimeout') && hookTimeout === undefined) {
      unported.push('hookTimeout: the value is not a literal number, so it was not ported');
    }
    if (present.has('maxWorkers') && maxWorkers === undefined) {
      unported.push('maxWorkers: the value is not a literal number, so it was not ported');
    }
    if (present.has('coverage') && !/coverage\s*:\s*\{/.test(text)) {
      unported.push('coverage: only the object form is ported; enable coverage by hand');
    }
  }

  return { settings, notes, unported, files, parallel, timeout: timeoutValue };
}

/**
 * Read the entries back out of a rendered `preload = [...]` line.
 *
 * `portVitestConfig` renders the line rather than returning the list, because the
 * settings it produces feed straight into `mergeBunfig`. The caller now has to merge
 * contributors across configs, so it needs the entries again; parsing its own
 * rendered form keeps one representation instead of two that can disagree.
 */
function parsePreloadLine(line) {
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Rebase a package's `setupFiles` entry onto the root `bunfig.toml`.
 *
 * `setupFiles: ['test/setup.ts']` is relative to the config that declares it.
 * Writing that string into the root preload made Bun look for
 * `<root>/test/setup.ts`; every package has its own `test/setup.ts`, so a real
 * monorepo failed with `preload not found` before running a single test.
 *
 * The candidate must actually exist under the config's directory: that keeps a
 * package specifier such as `vitest-canvas-mock` or `lib/setup` from being
 * rewritten into a path that does not exist.
 */
function rebasePreloadEntry(project, entry, configFile) {
  if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) return entry;
  const directory = posix.dirname(configFile.replaceAll('\\', '/'));
  const candidate = posix.normalize(
    posix.join(directory === '.' ? '' : directory, entry.replaceAll('\\', '/')),
  );
  if (!existsSync(join(project.root, candidate))) return entry;
  return candidate.startsWith('.') ? candidate : `./${candidate}`;
}

/**
 * Read the entries of an existing `preload = [...]` in a `bunfig.toml`.
 *
 * Parsed with `Bun.TOML` rather than a regex. A regex has to duplicate TOML's
 * quoting, comment and continuation rules, and the first attempt got them wrong in
 * a way that produced broken output: stripping `#` comments before matching left an
 * unbalanced quote, so a wrapped array or a line with a trailing comment came back
 * as `preload = ["./a.ts\", "./b.ts\"]` — the entry text kept a stray quote and the
 * array was no longer valid TOML.
 *
 * A file that does not parse is treated as having no preload, because the caller
 * only needs to know what to preserve and a broken bunfig is Bun's error to report,
 * not something to guess at here.
 */
function readExistingPreload(text) {
  if (!text) return [];
  let parsed;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return [];
  }
  const entries = parsed?.test?.preload;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * The name of the preload file a migrated timeout lives in.
 *
 * A dedicated file rather than the project's own setup file: appending to a file
 * the migration did not create means editing something whose other contents it
 * cannot reason about, and an existing `setupFiles` entry keeps working because
 * both are listed in `preload`.
 */
export const TIMEOUT_PRELOAD = 'bun-migrate.timeout.ts';

/**
 * Read a numeric option such as `testTimeout: 10000` or `maxWorkers: 4`.
 *
 * Returns undefined when the value is not a literal number, so a computed timeout
 * is reported as unported instead of being carried as a guess.
 */
function numericSetting(text, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*(\\d[\\d_]*)\\b`).exec(text);
  if (!match) return;
  return Number.parseInt(match[1].replaceAll('_', ''), 10);
}

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

/**
 * Read a pnpm-workspace.yaml with the YAML parser Bun ships.
 *
 * The previous line regex could not see a trailing comment (`- 'packages/*' # all
 * packages` became a glob containing the comment), and it treated every top-level
 * key outside `packages`/`catalog` as irrelevant: `onlyBuiltDependencies`,
 * `peerDependencyRules` and the rest disappeared when the file was removed, with
 * no journal line naming them. Parsing the document lets every top-level key be
 * either translated or reported.
 *
 * `ok: false` means the document could not be understood; the caller must leave it
 * in place rather than delete a file whose contents it could not inspect.
 */
export function parsePnpmWorkspace(text) {
  let parsed;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      packages: [],
      catalog: {},
      unsupported: [`pnpm-workspace.yaml could not be parsed (${detail}); it was left in place`],
    };
  }
  if (parsed === null || parsed === undefined) {
    return { ok: true, packages: [], catalog: {}, unsupported: [] };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      packages: [],
      catalog: {},
      unsupported: ['pnpm-workspace.yaml is not a YAML mapping; it was left in place'],
    };
  }

  const packages = [];
  const catalog = {};
  const unsupported = [];
  if (parsed.packages !== undefined) {
    if (!Array.isArray(parsed.packages)) {
      unsupported.push('packages is not a list');
    } else {
      for (const entry of parsed.packages) {
        if (typeof entry === 'string') packages.push(entry);
        else unsupported.push(`packages entry ${JSON.stringify(entry)} is not a string`);
      }
    }
  }
  if (parsed.catalog !== undefined) {
    if (
      parsed.catalog === null ||
      typeof parsed.catalog !== 'object' ||
      Array.isArray(parsed.catalog)
    ) {
      unsupported.push('catalog is not a mapping');
    } else {
      for (const [name, version] of Object.entries(parsed.catalog)) {
        if (typeof version === 'string' || typeof version === 'number')
          catalog[name] = String(version);
        else unsupported.push(`catalog entry "${name}" is not a string`);
      }
    }
  }
  if (parsed.catalogs !== undefined) {
    unsupported.push('named catalogs');
    if (parsed.catalogs && typeof parsed.catalogs === 'object' && !Array.isArray(parsed.catalogs)) {
      for (const name of Object.keys(parsed.catalogs)) unsupported.push(`named catalog "${name}"`);
    }
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'packages' || key === 'catalog' || key === 'catalogs') continue;
    if (key === 'overrides' || key === 'patchedDependencies') {
      unsupported.push(key);
      continue;
    }
    unsupported.push(`${key} is not translated`);
  }
  return { ok: true, packages, catalog, unsupported: [...new Set(unsupported)] };
}

/**
 * Mirror a package's `imports` map into its tsconfig `paths`.
 *
 * Bun 1.4.4 (38afee6c8) rejects a specifier that is `#` or starts with `#/`
 * before it consults the imports map (`src/resolver/resolver.rs:5052`). That is
 * the ESM rule Node 24 enforces too; Node 26.8 and Vite resolve the same `#/foo`
 * through a `#/*` entry, and the official project relies on that bundler
 * resolution. Bun checks tsconfig `paths` before package imports (`resolver.rs`
 * around :2567 versus the package-imports branch at :2609), so mirroring the map
 * into `paths` keeps the source unchanged and lets Bun resolve it. Prefixed
 * patterns (`#comp/*`) need no bridge, but the mapping is harmless for them.
 * Nested package boundaries (`src/human/package.json` with its own `imports`)
 * get their own tsconfig for the same reason.
 */
function importPathMappings(imports) {
  const mappings = {};
  for (const [key, value] of Object.entries(imports)) {
    const targets = Array.isArray(value) ? value : [value];
    if (!targets.every((target) => typeof target === 'string')) return;
    mappings[key] = targets;
  }
  return Object.keys(mappings).length > 0 ? mappings : undefined;
}

function matchingBrace(text, openIndex) {
  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function insertTsconfigPaths(text, mappings, addBaseUrl) {
  const open = /"compilerOptions"\s*:\s*\{/.exec(text);
  if (!open) return;
  const braceIndex = open.index + open[0].length - 1;
  const close = matchingBrace(text, braceIndex);
  if (close < 0) return;
  const body = text.slice(braceIndex + 1, close);
  const stripped = body
    .replaceAll(/\/\/.*$/gm, '')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  const lineStart = text.lastIndexOf('\n', braceIndex) + 1;
  const outerIndent = /^\s*/.exec(text.slice(lineStart))[0];
  const innerIndent = `${outerIndent}  `;
  const entries = [];
  if (addBaseUrl) entries.push('"baseUrl": "."');
  entries.push(`"paths": ${JSON.stringify(mappings)}`);
  const rendered = entries.join(`,\n${innerIndent}`);
  const insertion =
    stripped === ''
      ? `\n${innerIndent}${rendered}\n${outerIndent}`
      : `\n${innerIndent}${rendered},\n${innerIndent}`;
  return `${text.slice(0, braceIndex + 1)}${insertion}${text.slice(braceIndex + 1)}`;
}

function mirrorPackageImports(project, journal) {
  for (const directory of project.manifestDirectories ?? []) {
    const manifestPath = directory === '' ? 'package.json' : `${directory}/package.json`;
    const manifestText = readText(project, manifestPath);
    if (manifestText === undefined) continue;
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      continue;
    }
    const imports = manifest.imports;
    if (imports === null || typeof imports !== 'object' || Array.isArray(imports)) continue;
    const mappings = importPathMappings(imports);
    if (mappings === undefined) continue;

    const tsconfigPath = directory === '' ? 'tsconfig.json' : `${directory}/tsconfig.json`;
    const tsconfigText = journal.readFile(tsconfigPath) ?? readText(project, tsconfigPath);
    if (tsconfigText === undefined) {
      const content = `${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: mappings } }, null, 2)}\n`;
      journal.create(
        tsconfigPath,
        content,
        'packages',
        `mirrored ${Object.keys(mappings).length} package import pattern(s) into tsconfig paths for Bun`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = Bun.JSONC.parse(tsconfigText);
    } catch {
      journal.skip(
        tsconfigPath,
        'packages',
        'tsconfig could not be parsed; mirror the package imports into compilerOptions.paths by hand',
      );
      continue;
    }
    const compilerOptions = parsed?.compilerOptions;
    const baseUrl = compilerOptions?.baseUrl;
    if (baseUrl !== undefined && baseUrl !== '.') {
      journal.skip(
        tsconfigPath,
        'packages',
        `compilerOptions.baseUrl is "${String(baseUrl)}"; the package imports mapping assumes ".", so it was not mirrored`,
      );
      continue;
    }
    const existingPaths = compilerOptions?.paths;
    const satisfied =
      existingPaths !== null &&
      typeof existingPaths === 'object' &&
      Object.entries(mappings).every(
        ([key, targets]) =>
          Array.isArray(existingPaths[key]) &&
          targets.every((target) => existingPaths[key].includes(target)),
      );
    if (satisfied) continue;
    if (existingPaths !== undefined) {
      journal.skip(
        tsconfigPath,
        'packages',
        'compilerOptions.paths already exists; merge the package imports mapping by hand',
      );
      continue;
    }
    const inserted = insertTsconfigPaths(tsconfigText, mappings, baseUrl === undefined);
    if (inserted === undefined) {
      journal.skip(
        tsconfigPath,
        'packages',
        'tsconfig has no compilerOptions object; mirror the package imports by hand',
      );
      continue;
    }
    try {
      Bun.JSONC.parse(inserted);
    } catch {
      journal.skip(
        tsconfigPath,
        'packages',
        'adding the package imports mapping would produce invalid JSONC; mirror it by hand',
      );
      continue;
    }
    journal.set(
      tsconfigPath,
      inserted,
      'packages',
      `mirrored ${Object.keys(mappings).length} package import pattern(s) into tsconfig paths for Bun`,
      tsconfigText,
    );
  }
}

export function applyPackageLayer(project, journal) {
  if (!journal.enabled('packages')) return;
  const overrides = loadProjectOverrides(project.config);
  const deny = denyList(overrides);
  mirrorPackageImports(project, journal);

  for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
    if (readText(project, lockfile) !== undefined) {
      journal.remove(
        lockfile,
        'packages',
        'bun install --lockfile-only reads the existing lockfile and writes bun.lock',
        readText(project, lockfile),
      );
    }
  }

  const workspaceText = readText(project, 'pnpm-workspace.yaml');
  if (workspaceText) {
    const parsed = parsePnpmWorkspace(workspaceText);
    const staged = journal.current('package.json');
    let manifest;
    try {
      manifest = staged !== undefined ? JSON.parse(staged) : project.readJson('package.json');
    } catch {
      manifest = project.readJson('package.json');
    }
    const hasCatalog = Object.keys(parsed.catalog).length > 0;
    if (manifest && (parsed.packages.length > 0 || hasCatalog)) {
      const existing = Array.isArray(manifest.workspaces)
        ? manifest.workspaces
        : Array.isArray(manifest.workspaces?.packages)
          ? manifest.workspaces.packages
          : [];
      const merged = [...new Set([...existing, ...parsed.packages])];
      const existingCatalog = manifest.workspaces?.catalog ?? {};
      const mergedCatalog = { ...existingCatalog, ...parsed.catalog };
      const listChanged =
        merged.length !== existing.length ||
        merged.some((value, index) => value !== existing[index]);
      const catalogChanged =
        Object.keys(mergedCatalog).length !== Object.keys(existingCatalog).length ||
        Object.entries(parsed.catalog).some(([name, version]) => existingCatalog[name] !== version);
      if (listChanged || catalogChanged) {
        const next = {
          ...manifest,
          workspaces: {
            ...(Array.isArray(manifest.workspaces) ? {} : manifest.workspaces),
            packages: merged,
            ...(Object.keys(mergedCatalog).length > 0 ? { catalog: mergedCatalog } : {}),
          },
        };
        const detail = [
          parsed.packages.length > 0
            ? `folded ${parsed.packages.length} workspace glob(s)`
            : undefined,
          hasCatalog ? `moved ${Object.keys(parsed.catalog).length} catalog entr(ies)` : undefined,
        ]
          .filter(Boolean)
          .join(' and ');
        journal.set(
          'package.json',
          `${JSON.stringify(next, null, 2)}\n`,
          'packages',
          `${detail} from pnpm-workspace.yaml`,
          // The disk bytes, not a re-serialization: revert must restore the file
          // exactly as it was, whitespace included.
          project.rawText('package.json') ?? `${JSON.stringify(manifest, null, 2)}\n`,
        );
      }
    }
    for (const unsupported of parsed.unsupported) {
      journal.skip(
        'pnpm-workspace.yaml',
        'packages',
        `${unsupported} needs a manual decision: Bun's shape differs from pnpm's`,
      );
    }
    if (
      parsed.ok &&
      parsed.unsupported.length === 0 &&
      (parsed.packages.length > 0 || hasCatalog)
    ) {
      journal.remove(
        'pnpm-workspace.yaml',
        'packages',
        'workspace globs and catalog entries moved into root package.json',
        workspaceText,
      );
    }
  }

  let parallelWorkers;
  /**
   * `preload` is a single array key, so two configs that both contribute to it
   * cannot each write their own line: `mergeBunfig` keeps the last value for a key,
   * and the earlier list disappears. Measured before this was fixed — a project with
   * `vitest.config.ts` (`testTimeout`) and `vitest.workspace.ts` (`setupFiles`)
   * produced `preload = ["./test/setup.ts"]`, dropping the generated timeout file
   * that was still written to disk: the timeout silently stopped applying.
   *
   * The lists are accumulated here and written once, after every config has been
   * read, so each contributor's entries survive.
   */
  const preloadEntries = [];
  const timeoutContributors = new Map();
  let configCount = 0;
  for (const file of project.files) {
    if (!/(^|\/)vitest\.(config|projects|workspace)\.(ts|mts|js|mjs)$/.test(file)) continue;
    if (isDeniedFile(file, deny)) continue;
    if (overrides.portable) {
      journal.skip(
        file,
        'packages',
        'portable = true: porting a vitest config to bunfig.toml is Bun-only; the file was left in place',
      );
      continue;
    }
    configCount += 1;
    const text = readText(project, file) ?? '';
    const ported = portVitestConfig(text);
    if (ported.parallel !== undefined) {
      if (parallelWorkers === undefined) {
        parallelWorkers = ported.parallel;
      } else if (parallelWorkers !== ported.parallel) {
        journal.skip(
          file,
          'packages',
          `maxWorkers: ${ported.parallel} conflicts with ${parallelWorkers} from another config; using ${parallelWorkers}`,
        );
      }
    }
    if (ported.timeout !== undefined) {
      const bucket = timeoutContributors.get(ported.timeout) ?? [];
      bucket.push(file);
      timeoutContributors.set(ported.timeout, bucket);
    }
    for (const setting of ported.settings) {
      if (setting.key !== 'preload') continue;
      for (const entry of parsePreloadLine(setting.line)) {
        if (entry === TIMEOUT_PRELOAD || entry === `./${TIMEOUT_PRELOAD}`) continue;
        preloadEntries.push(rebasePreloadEntry(project, entry, file));
      }
    }
    const parts = [];
    if (ported.notes.length > 0)
      parts.push(`ported to bunfig.toml [test]: ${ported.notes.join(', ')}`);
    if (ported.unported.length > 0)
      parts.push(`still needs a manual decision: ${ported.unported.join(', ')}`);
    const reason = parts.length === 0 ? 'bun:test needs no project config' : parts.join('; ');
    journal.remove(file, 'packages', reason, text);
    const own = ported.settings.filter((setting) => setting.key !== 'preload');
    if (own.length > 0) {
      const bunfigOnDisk = readText(project, 'bunfig.toml');
      const existing = journal.readFile('bunfig.toml') ?? bunfigOnDisk ?? '';
      const merged = mergeBunfig(existing, own);
      // before is the disk bytes (undefined when the migration creates the
      // file), so revert removes a generated bunfig instead of leaving 0 bytes.
      journal.set(
        'bunfig.toml',
        merged,
        'packages',
        `test settings recovered from ${file}`,
        bunfigOnDisk,
      );
    }
  }

  /**
   * `bunfig.toml` has one `[test] preload` list and Bun has one default for
   * tests and hooks. A timeout can only be represented for a project whose
   * single test configuration declares it.
   *
   * A monorepo commonly has several configs with different values (the official
   * repository has 15 s and 30 s). Picking one — least of all the largest —
   * imposes that deadline on packages that chose another, so a timeout that
   * masks slow work is exactly what this tool must not do. Every per-package
   * value is reported instead, and no global timeout is written.
   */
  if (timeoutContributors.size > 0) {
    if (configCount === 1 && timeoutContributors.size === 1) {
      const chosen = [...timeoutContributors.keys()][0];
      const content = [
        "import { setDefaultTimeout } from 'bun:test';",
        '',
        `setDefaultTimeout(${chosen});`,
        '',
      ].join('\n');
      const existing = journal.readFile(TIMEOUT_PRELOAD) ?? readText(project, TIMEOUT_PRELOAD);
      const detail = `recovered the vitest timeout from ${[...timeoutContributors.values()].flat().join(', ')}; loaded through [test] preload`;
      if (existing === undefined) {
        journal.create(TIMEOUT_PRELOAD, content, 'packages', detail);
      } else if (existing !== content) {
        journal.set(TIMEOUT_PRELOAD, content, 'packages', detail, existing);
      }
      preloadEntries.push(`./${TIMEOUT_PRELOAD}`);
    } else {
      for (const [value, files] of timeoutContributors) {
        for (const file of files) {
          journal.skip(
            file,
            'packages',
            `testTimeout: ${value}ms belongs to this package's config; a single root bun:test preload cannot represent ${configCount} configs, so no global timeout was set. Configure it per package or keep Bun's default.`,
          );
        }
      }
    }
  }

  if (preloadEntries.length > 0) {
    const bunfigOnDisk = readText(project, 'bunfig.toml');
    const existing = journal.readFile('bunfig.toml') ?? bunfigOnDisk ?? '';
    /**
     * A project may already list its own preloads. Replacing the key would drop them:
     * measured, a `bunfig.toml` with `preload = ["./my-own-setup.ts"]` came out as
     * `preload = ["./bun-migrate.timeout.ts"]`, so the project's own setup file
     * stopped loading and only the generated timeout stayed. The existing entries are
     * merged in front, because they were there first and their order is the project's.
     */
    const unique = [...new Set([...readExistingPreload(existing), ...preloadEntries])];
    const line = `preload = [${unique.map((entry) => `"${entry}"`).join(', ')}]`;
    const merged = mergeBunfig(existing, [{ table: 'test', key: 'preload', line }]);
    // before is the disk bytes (undefined when the migration creates the file),
    // so revert removes a generated bunfig instead of leaving 0 bytes.
    journal.set(
      'bunfig.toml',
      merged,
      'packages',
      `preload lists ${unique.length} entr(y/ies) collected from every ported config and the existing bunfig`,
      bunfigOnDisk,
    );
  }

  /**
   * `bunfig.toml` cannot carry the worker count — measured, `[test] parallel = 4`
   * is accepted and ignored — so the only place it can live is the test script.
   * It is appended rather than replacing arguments a project already passes.
   */
  if (parallelWorkers !== undefined) {
    applyParallelToTestScript(project, journal, parallelWorkers);
  }

  journal.note(
    'packages',
    'run `bun install --lockfile-only` next: Bun converts an existing pnpm/yarn/npm lockfile into bun.lock',
  );
}

/**
 * Add `--parallel=N` to every test script that runs `bun test` without it.
 *
 * Idempotent: a script that already carries `--parallel` is left byte-identical, so
 * running the migration twice does not stack the flag.
 */
function applyParallelToTestScript(project, journal, workers) {
  const staged = journal.current('package.json');
  let manifest;
  try {
    manifest = staged !== undefined ? JSON.parse(staged) : project.readJson('package.json');
  } catch {
    manifest = project.readJson('package.json');
  }
  if (!manifest?.scripts) return;
  const nextScripts = { ...manifest.scripts };
  const changed = [];
  for (const [name, value] of Object.entries(manifest.scripts)) {
    const script = String(value);
    if (!/\bbun\s+test\b/.test(script)) continue;
    if (/--parallel[= ]/.test(script)) continue;
    nextScripts[name] = script.replaceAll(/\bbun\s+test\b/g, `bun test --parallel=${workers}`);
    changed.push(name);
  }
  if (changed.length === 0) return;
  const next = { ...manifest, scripts: nextScripts };
  journal.set(
    'package.json',
    `${JSON.stringify(next, null, 2)}\n`,
    'packages',
    `maxWorkers -> --parallel=${workers} in script(s): ${changed.join(', ')}`,
    project.rawText('package.json') ?? `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
