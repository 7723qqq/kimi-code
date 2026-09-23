/**
 * Surface contract — pins the three export surfaces against each other so
 * drift (ghost wrappers, unwrapped native exports, undeclared types) fails
 * in CI instead of surfacing as runtime TypeErrors.
 *
 *   1. every `binding.X` referenced by index.native.cjs exists on the raw native
 *      binding (ghost-wrapper check — e.g. a wrapper for a function the
 *      Rust crate never exported);
 *   2. every function the native binding exports is wrapped by index.native.cjs
 *      or explicitly allowlisted (broken-chain check — e.g. a Rust export the
 *      wrapper never forwards, which used to silently disable the whole
 *      knowledge domain);
 *   3. every wrapper export is declared in index.native.d.ts (type-surface
 *      completeness);
 *   4. allowlist entries stay honest: an entry that gains a wrapper must be
 *      removed from the list.
 *
 * Skips when the native binding cannot be loaded (CI jobs without a native
 * build); the check only means something against a real binary.
 *
 * Must run under `bun --bun`: under a Node runtime, Bun's CJS interop degrades
 * — the wrapper loads as empty `module.exports` (or the load fails outright),
 * so the true surface is invisible. A load failure or a missing `__binding`
 * both skip the suite.
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
  // eslint-disable-next-line import/extensions -- require() needs the real file extension
  wrapper = require('../index.native.cjs') as Record<string, unknown>;
} catch (error) {
  loadError = error;
}

/**
 * Native exports intentionally not referenced via `binding.X` by index.native.cjs.
 * - workspace index functions: Rust exports with no JS consumer yet.
 * - nativeIsSensitiveFile: wrapped through the latin1-bytes variant
 *   (nativeIsSensitiveFileBytes) to avoid UTF-16 conversion overhead.
 * - the engine-domain exports (turn loop / session handles / tracing):
 *   consumed through `session-handle.ts`, not through the native-tools wrapper
 *   surface.
 */
const UNWRAPPED_BINDINGS = new Set([
  'nativeBuildWorkspaceIndex',
  'nativeWorkspaceIndexPredictRead',
  'nativeIsSensitiveFile',
  'cancelTurn',
  'runTurnRust',
  'sessionStatus',
  'sessionMcpServers',
  'sessionWarnings',
  'resolveCallback',
  'sessionDispose',
  'sessionSettled',
  'sessionIsSettled',
  'getCallbackPayload',
  'sessionCancelTurn',
  'sessionGetHistory',
  'sessionHistoryLen',
  'sessionSetHistory',
  'emitTestTraceEvent',
  'initTracingFromEnv',
  'sessionEnqueueTurn',
  'sessionTurnOutcome',
  'createEngineSession',
  'sessionClearHistory',
  'sessionExtendHistory',
  'sessionReleaseQuiescence',
  'sessionTryAcquireQuiescence',
  'sessionStartBtw',
  'sessionBtwPrompt',
  'sessionBtwCancel',
  'sessionGenerateTitle',
  'sessionCompact',
  'sessionCancelCompaction',
  'setEngineLocale',
  'clearEngineLocale',
]);

// Under a Node runtime Bun's CJS interop degrades: the load can throw outright
// or resolve to empty exports, so a missing `__binding` is treated the same as
// a failed load. vitest still executes a skipped suite's body during
// collection, so the derivations below must tolerate `wrapper === undefined`.
const surfaceAvailable = wrapper !== undefined && wrapper['__binding'] !== undefined;

describe.skipIf(!surfaceAvailable)('native tools export surface contract', () => {
  const wrapperExports = wrapper ?? {};
  const raw = (wrapperExports['__binding'] ?? {}) as Record<string, unknown>;
  const source = readFileSync(join(pkgDir, 'index.native.cjs'), 'utf8');
  const dts = readFileSync(join(pkgDir, 'index.native.d.ts'), 'utf8');

  const referenced = new Set(
    [...source.matchAll(/\bbinding\.(\w+)/g)].map((match) => match[1] as string),
  );
  const rawFunctionNames = Object.keys(raw).filter((name) => typeof raw[name] === 'function');
  const wrapperFunctionNames = Object.keys(wrapperExports).filter(
    (name) => typeof wrapperExports[name] === 'function',
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
    const extra = Object.keys(wrapperExports).filter(
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
