/**
 * Optional native clipboard binding.
 *
 * `@mariozechner/clipboard` is a native Node binding that can read image
 * binaries from the system clipboard on macOS and Windows. It's an
 * optional dependency — if the native module fails to load (e.g. on a
 * platform where no prebuilt is available) we degrade to shell-based
 * fallbacks (wl-paste / xclip / PowerShell) in `clipboard-image.ts`.
 */

import { createRequire } from 'node:module';

import { loadNativePackage } from '#/native/native-require';

declare const __KIMI_CODE_NATIVE_BUNDLE__: boolean | undefined;

const nodeRequire = createRequire(import.meta.url);

export interface ClipboardModule {
  availableFormats?(): string[];
  hasText?(): boolean;
  getText?(): Promise<string>;
  setText?(text: string): Promise<void>;
  hasImage(): boolean;
  getImageBinary(): Promise<Array<number>>;
}

export interface ClipboardNativeDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isNativeBundle: boolean;
  readonly loadNativePackage: (packageName: string) => ClipboardModule | null;
  readonly requirePackage: (packageName: string) => unknown;
}

export function createClipboardNativeDeps(
  overrides: Partial<ClipboardNativeDeps> = {},
): ClipboardNativeDeps {
  return {
    platform: process.platform,
    env: process.env,
    isNativeBundle: typeof __KIMI_CODE_NATIVE_BUNDLE__ === 'boolean' && __KIMI_CODE_NATIVE_BUNDLE__,
    loadNativePackage: (packageName) => loadNativePackage<ClipboardModule>(packageName),
    requirePackage: (packageName) => nodeRequire(packageName) as unknown,
    ...overrides,
  };
}

/**
 * Load the optional native binding. Returns null on Termux, on Linux without a
 * display (the binding would only fail later), or when no module can be
 * resolved.
 */
export function loadClipboardModule(
  overrides: Partial<ClipboardNativeDeps> = {},
): ClipboardModule | null {
  const deps = createClipboardNativeDeps(overrides);
  if (deps.env['TERMUX_VERSION'] !== undefined) return null;
  if (deps.platform === 'linux') {
    const display = deps.env['DISPLAY'] ?? deps.env['WAYLAND_DISPLAY'];
    if (!display) return null;
  }
  try {
    const bundledClipboard = deps.loadNativePackage('@mariozechner/clipboard');
    if (bundledClipboard !== null) return bundledClipboard;
  } catch {
    return null;
  }
  if (deps.isNativeBundle) return null;
  try {
    return deps.requirePackage('@mariozechner/clipboard') as ClipboardModule;
  } catch {
    return null;
  }
}

export const clipboard: ClipboardModule | null = loadClipboardModule();
