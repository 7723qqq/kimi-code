/**
 * Surface contract — pins the three export surfaces against each other so
 * drift (ghost wrappers, unwrapped native exports, undeclared types) fails
 * in CI instead of surfacing as runtime TypeErrors.
 *
 *   1. every `binding.X` referenced by index.js exists on the raw native
 *      binding (ghost-wrapper check — e.g. a wrapper for a function the
 *      Rust crate never exported);
 *   2. every function the native binding exports is wrapped by index.js or
 *      explicitly allowlisted (broken-chain check — e.g. a Rust export the
 *      wrapper never forwards, which used to silently disable the whole
 *      knowledge domain);
 *   3. every wrapper export is declared in index.d.ts (type-surface
 *      completeness);
 *   4. allowlist entries stay honest: an entry that gains a wrapper must be
 *      removed from the list.
 *
 * Skips when the native binding cannot be loaded (CI jobs without a native
 * build); the check only means something against a real binary.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let wrapper: Record<string, unknown> | undefined;
let loadError: unknown;
try {
  wrapper = require('../index') as Record<string, unknown>;
} catch (error) {
  loadError = error;
}

/**
 * Native exports intentionally not referenced via `binding.X` by index.js.
 * - workspace index functions: Rust exports with no JS consumer yet.
 * - nativeIsSensitiveFile: wrapped through the latin1-bytes variant
 *   (nativeIsSensitiveFileBytes) to avoid UTF-16 conversion overhead.
 */
const UNWRAPPED_BINDINGS = new Set([
  'nativeBuildWorkspaceIndex',
  'nativeWorkspaceIndexPredictRead',
  'nativeIsSensitiveFile',
]);

describe.skipIf(wrapper === undefined)('native tools export surface contract', () => {
  const raw = (wrapper as Record<string, unknown>)['__binding'] as Record<string, unknown>;
  const source = readFileSync(join(pkgDir, 'index.js'), 'utf8');
  const dts = readFileSync(join(pkgDir, 'index.d.ts'), 'utf8');

  const referenced = new Set(
    [...source.matchAll(/\bbinding\.(\w+)/g)].map((match) => match[1] as string),
  );
  const rawFunctionNames = Object.keys(raw).filter((name) => typeof raw[name] === 'function');
  const wrapperFunctionNames = Object.keys(wrapper as Record<string, unknown>).filter(
    (name) => typeof (wrapper as Record<string, unknown>)[name] === 'function',
  );
  const declared = new Set(
    [...dts.matchAll(/export (?:declare )?(?:async )?(?:function|const) (\w+)/g)].map(
      (match) => match[1] as string,
    ),
  );

  it('loads a non-empty native binding', () => {
    expect(loadError).toBeUndefined();
    expect(rawFunctionNames.length).toBeGreaterThan(0);
  });

  it('every binding.X reference in index.js exists on the native binding', () => {
    const ghosts = [...referenced].filter((name) => !(name in raw));
    expect(
      ghosts,
      `index.js references binding.${ghosts.join(', binding.')} which the native module does not export — implement it in Rust or drop the wrapper`,
    ).toEqual([]);
  });

  it('every native export is wrapped by index.js or explicitly allowlisted', () => {
    const orphaned = rawFunctionNames.filter(
      (name) => !referenced.has(name) && !UNWRAPPED_BINDINGS.has(name),
    );
    expect(
      orphaned,
      `the native binding exports ${orphaned.join(', ')} but index.js never forwards them — add a wrapper or allowlist the name`,
    ).toEqual([]);
  });

  it('every wrapper export is declared in index.d.ts', () => {
    const undeclared = wrapperFunctionNames.filter((name) => !declared.has(name));
    expect(
      undeclared,
      `index.js exports ${undeclared.join(', ')} without a declaration in index.d.ts`,
    ).toEqual([]);
  });

  it('wrapper exports stay within the declared surface (no extra runtime keys)', () => {
    const extra = Object.keys(wrapper as Record<string, unknown>).filter(
      (name) => !declared.has(name) && name !== '__binding',
    );
    expect(extra).toEqual([]);
  });

  it('allowlist entries are honest (never referenced by a wrapper)', () => {
    const stale = [...UNWRAPPED_BINDINGS].filter((name) => referenced.has(name));
    expect(
      stale,
      `allowlisted bindings ${stale.join(', ')} gained wrappers — remove them from UNWRAPPED_BINDINGS`,
    ).toEqual([]);
  });
});

describe('native tools export surface contract (binding unavailable)', () => {
  it.skipIf(wrapper !== undefined)(
    'skips when the native binding cannot be loaded',
    () => {
      expect(loadError).toBeDefined();
    },
  );
});
