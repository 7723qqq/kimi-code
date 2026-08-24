import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  ensureNodePtyBindingForBun,
  ensurePiTuiNativeHelperForBun,
  getNativePackageRoot,
} from './native-assets';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
let installed = false;

// pi-tui loads its platform-specific native helpers via an absolute-path
// require() computed from import.meta.url / process.execPath
// (see pi-tui dist/terminal.js and dist/native-modifiers.js). In a SEA binary
// those .node files live in the native-asset cache, so redirect any absolute
// require of a pi-tui native helper to the cached copy.
//
// Path shape: native/<darwin|win32>/prebuilds/<arch>/<file>.node — note the
// two path segments after "prebuilds", so ".+" (not "[^/]+") is required.
const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin)[\\/]prebuilds[\\/].+\.node$/;

// node-pty loads its bindings through lib/utils.js loadNativeModule with
// RELATIVE requests (`../build/Release/<name>.node`, `../prebuilds/<p>-<a>/...`),
// which resolve against the bundled main.cjs's directory — where no binding
// exists in a packaged build. Redirect those to the cached copy extracted from
// the embedded manifest (see node-pty in scripts/native/native-deps.mjs).
const NODE_PTY_REQUEST_PATTERN =
  /^[.]{1,2}[\\/](?:build[\\/](?:Release|Debug)|prebuilds[\\/][^\\/]+)[\\/][^\\/]+\.node$/;

export function installNativeModuleHook(): void {
  if (installed) return;
  installed = true;

  // Bun documents Module._load overrides as no-ops, and its runtime plugin API
  // cannot express this redirect either: Bun.plugin's build.module() accepts
  // exact string ids only (no patterns), and .node specifiers bypass runtime
  // plugin callbacks entirely, going straight to dlopen (verified on Bun 1.4.0).
  // Installing the hook anyway would silently do nothing, so instead
  // materialize the helper at the path pi-tui itself computes inside the
  // single-file binary (see ensurePiTuiNativeHelperForBun) and warn only when
  // that is not possible.
  if (process.versions['bun'] !== undefined) {
    try {
      if (!ensurePiTuiNativeHelperForBun()) {
        process.stderr.write(
          'kimi: skipping pi-tui native helper restore under Bun: embedded assets carry no platform helper\n',
        );
      }
      if (!ensureNodePtyBindingForBun()) {
        process.stderr.write(
          'kimi: skipping node-pty binding restore under Bun: embedded assets carry no node-pty files\n',
        );
      }
    } catch (error) {
      process.stderr.write(
        `kimi: skipping packaged native restore under Bun: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    return;
  }

  const moduleBuiltin = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = moduleBuiltin._load;
  if (originalLoad === undefined) return;

  moduleBuiltin._load = function loadWithNativeAssets(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (typeof request === 'string' && request.endsWith('.node')) {
      if (PI_TUI_NATIVE_PATTERN.test(request) && !existsSync(request)) {
        const pkgRoot = getNativePackageRoot('@moonshot-ai/pi-tui');
        if (pkgRoot !== null) {
          const match = request.match(PI_TUI_NATIVE_PATTERN);
          if (match !== null) {
            const redirected = join(pkgRoot, match[0]);
            return originalLoad.call(this, redirected, parent, isMain);
          }
        }
      } else if (NODE_PTY_REQUEST_PATTERN.test(request)) {
        const pkgRoot = getNativePackageRoot('node-pty');
        if (pkgRoot !== null) {
          const redirected = join(pkgRoot, request.replace(/^[.]{1,2}[\\/]/, ''));
          if (existsSync(redirected)) {
            return originalLoad.call(this, redirected, parent, isMain);
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
