import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureNodePtyBindingForBun,
  ensurePiTuiNativeHelperForBun,
  getNativePackageRoot,
} from '#/native/native-assets';

const nodeRequire = createRequire(import.meta.url);

vi.mock('#/native/native-assets', () => ({
  getNativePackageRoot: vi.fn((packageName: string) =>
    packageName === '@moonshot-ai/pi-tui' ? '/kimi-test-native-cache/pi-tui' : null,
  ),
  ensurePiTuiNativeHelperForBun: vi.fn(() => true),
  ensureNodePtyBindingForBun: vi.fn(() => true),
}));

const TEST_PKG_ROOT = '/kimi-test-native-cache/pi-tui';

interface LoadFn {
  (this: unknown, request: string, parent: unknown, isMain: boolean): unknown;
}

interface LoadableModule {
  _load?: LoadFn;
}

function moduleBuiltin(): LoadableModule {
  return nodeRequire('node:module') as LoadableModule;
}

function drivenRequests(capture: { requests: string[] }): string[] {
  return capture.requests.filter((request) => request !== 'node:module');
}

function stubLoadCapture(): { requests: string[]; restore: () => void } {
  const builtin = moduleBuiltin();
  const realLoad = builtin._load;
  if (realLoad === undefined) throw new Error('Module._load is unavailable');
  const requests: string[] = [];
  builtin._load = function capturedLoad(this: unknown, request, parent, isMain) {
    requests.push(request);
    return realLoad.call(this, request, parent, isMain);
  };
  return {
    requests,
    restore: () => {
      builtin._load = realLoad;
    },
  };
}

async function installFreshHook(): Promise<void> {
  vi.resetModules();
  const { installNativeModuleHook } = await import('#/native/module-hook');
  installNativeModuleHook();
}

describe('installNativeModuleHook', () => {
  let capture: { requests: string[]; restore: () => void } | null = null;

  beforeEach(() => {
    vi.mocked(getNativePackageRoot).mockReset();
    vi.mocked(getNativePackageRoot).mockReturnValue(TEST_PKG_ROOT);
    vi.mocked(ensurePiTuiNativeHelperForBun).mockReset();
    vi.mocked(ensurePiTuiNativeHelperForBun).mockReturnValue(true);
    vi.mocked(ensureNodePtyBindingForBun).mockReset();
    vi.mocked(ensureNodePtyBindingForBun).mockReturnValue(true);
  });

  afterEach(() => {
    capture?.restore();
    capture = null;
  });

  describe('Node path', () => {
    it('redirects missing pi-tui-shaped .node requires to the cached copy', async () => {
      capture = stubLoadCapture();
      await installFreshHook();

      const load = moduleBuiltin()._load as LoadFn;
      const request = '/app-bundle/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node';
      const redirected = join(
        TEST_PKG_ROOT,
        'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
      );
      expect(() => load(request, null, false)).toThrow(`Cannot find module '${redirected}'`);

      expect(drivenRequests(capture)).toEqual([redirected]);
    });

    it('redirects win32-shaped .node requires to the cached copy', async () => {
      capture = stubLoadCapture();
      await installFreshHook();

      const load = moduleBuiltin()._load as LoadFn;
      const request = '/app-bundle/native/win32/prebuilds/win32-x64/win32-console-mode.node';
      const redirected = join(
        TEST_PKG_ROOT,
        'native/win32/prebuilds/win32-x64/win32-console-mode.node',
      );
      expect(() => load(request, null, false)).toThrow(`Cannot find module '${redirected}'`);

      expect(drivenRequests(capture)).toEqual([redirected]);
    });

    it('falls through unchanged when no cached package root is available', async () => {
      vi.mocked(getNativePackageRoot).mockReturnValueOnce(null);
      capture = stubLoadCapture();
      await installFreshHook();

      const load = moduleBuiltin()._load as LoadFn;
      const request = '/app-bundle/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node';
      expect(() => load(request, null, false)).toThrow(`Cannot find module '${request}'`);
      expect(vi.mocked(getNativePackageRoot)).toHaveBeenCalledWith('@moonshot-ai/pi-tui');
      expect(drivenRequests(capture)).toEqual([request]);
    });

    it('does not redirect .node files that exist on disk', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'module-hook-existing-'));
      const existing = join(dir, 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node');
      mkdirSync(dirname(existing), { recursive: true });
      writeFileSync(existing, 'not a real dylib');
      capture = stubLoadCapture();
      try {
        await installFreshHook();

        const load = moduleBuiltin()._load as LoadFn;
        expect(() => load(existing, null, false)).toThrow();
        expect(drivenRequests(capture)).toEqual([existing]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes unrelated requests straight through', async () => {
      const expectedPath = nodeRequire('node:path');
      capture = stubLoadCapture();
      await installFreshHook();

      const load = moduleBuiltin()._load as LoadFn;
      const pathModule = load('node:path', null, false);
      expect(pathModule).toBe(expectedPath);
      expect(drivenRequests(capture)).toEqual(['node:path']);
    });

    it('redirects node-pty-shaped relative .node requires to the cached copy', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'module-hook-nodepty-'));
      try {
        const binding = join(dir, 'prebuilds/win32-x64/conpty.node');
        mkdirSync(dirname(binding), { recursive: true });
        writeFileSync(binding, 'not a real dll');
        vi.mocked(getNativePackageRoot).mockImplementation((packageName) =>
          packageName === 'node-pty' ? dir : null,
        );
        capture = stubLoadCapture();
        await installFreshHook();

        const load = moduleBuiltin()._load as LoadFn;
        const request = '../prebuilds/win32-x64/conpty.node';
        expect(() => load(request, null, false)).toThrow();

        expect(drivenRequests(capture)).toEqual([binding]);
        expect(vi.mocked(getNativePackageRoot)).toHaveBeenCalledWith('node-pty');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('redirects node-pty build/Release requires for linux-style layouts', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'module-hook-nodepty-'));
      try {
        const binding = join(dir, 'build/Release/pty.node');
        mkdirSync(dirname(binding), { recursive: true });
        writeFileSync(binding, 'not a real dylib');
        vi.mocked(getNativePackageRoot).mockImplementation((packageName) =>
          packageName === 'node-pty' ? dir : null,
        );
        capture = stubLoadCapture();
        await installFreshHook();

        const load = moduleBuiltin()._load as LoadFn;
        expect(() => load('../build/Release/pty.node', null, false)).toThrow();

        expect(drivenRequests(capture)).toEqual([binding]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('redirects node-pty requests with the doubled separators its loader concatenates', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'module-hook-nodepty-'));
      try {
        const binding = join(dir, 'prebuilds/linux-x64/pty.node');
        mkdirSync(dirname(binding), { recursive: true });
        writeFileSync(binding, 'not a real dylib');
        vi.mocked(getNativePackageRoot).mockImplementation((packageName) =>
          packageName === 'node-pty' ? dir : null,
        );
        capture = stubLoadCapture();
        await installFreshHook();

        const load = moduleBuiltin()._load as LoadFn;
        expect(() => load('./prebuilds/linux-x64//pty.node', null, false)).toThrow();

        expect(drivenRequests(capture)).toEqual([binding]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes node-pty-shaped requests through when no cache root exists', async () => {
      vi.mocked(getNativePackageRoot).mockReturnValue(null);
      capture = stubLoadCapture();
      await installFreshHook();

      const load = moduleBuiltin()._load as LoadFn;
      const request = '../prebuilds/win32-x64/conpty.node';
      expect(() => load(request, null, false)).toThrow();

      expect(drivenRequests(capture)).toEqual([request]);
    });

    it('is idempotent: repeated installs do not wrap twice', async () => {
      capture = stubLoadCapture();
      vi.resetModules();
      const { installNativeModuleHook } = await import('#/native/module-hook');
      installNativeModuleHook();
      installNativeModuleHook();

      const load = moduleBuiltin()._load as LoadFn;
      expect(load('node:path', null, false)).toBeDefined();
      expect(drivenRequests(capture)).toEqual(['node:path']);
    });
  });

  describe('under Bun', () => {
    function stubBunVersion(): void {
      Object.defineProperty(process.versions, 'bun', {
        value: '1.4.0',
        configurable: true,
      });
    }

    function clearBunVersion(): void {
      delete (process.versions as Record<string, unknown>)['bun'];
    }

    afterEach(() => {
      clearBunVersion();
    });

    it('materializes the helper instead of installing a dead hook', async () => {
      stubBunVersion();
      const builtin = moduleBuiltin();
      const sentinel = builtin._load;
      if (sentinel === undefined) throw new Error('Module._load is unavailable');
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.resetModules();
        const { installNativeModuleHook } = await import('#/native/module-hook');

        installNativeModuleHook();
        expect(vi.mocked(ensurePiTuiNativeHelperForBun)).toHaveBeenCalledTimes(1);
        expect(writeSpy).not.toHaveBeenCalled();
        expect(builtin._load).toBe(sentinel);

        installNativeModuleHook();
        expect(vi.mocked(ensurePiTuiNativeHelperForBun)).toHaveBeenCalledTimes(1);
        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
        builtin._load = sentinel;
      }
    });

    it('warns loudly when the embedded assets carry no helper', async () => {
      vi.mocked(ensurePiTuiNativeHelperForBun).mockReturnValue(false);
      stubBunVersion();
      const builtin = moduleBuiltin();
      const sentinel = builtin._load;
      if (sentinel === undefined) throw new Error('Module._load is unavailable');
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.resetModules();
        const { installNativeModuleHook } = await import('#/native/module-hook');

        installNativeModuleHook();
        expect(writeSpy).toHaveBeenCalledTimes(1);
        const message = String(writeSpy.mock.calls[0]?.[0]);
        expect(message).toMatch(/[Bb]un/);
        expect(message).toMatch(/pi-tui/);
        expect(builtin._load).toBe(sentinel);

        installNativeModuleHook();
        expect(writeSpy).toHaveBeenCalledTimes(1);
      } finally {
        writeSpy.mockRestore();
        builtin._load = sentinel;
      }
    });

    it('reports the reason when helper materialization throws', async () => {
      vi.mocked(ensurePiTuiNativeHelperForBun).mockImplementation(() => {
        throw new Error('Native asset checksum mismatch for native/test-target/helper');
      });
      stubBunVersion();
      const builtin = moduleBuiltin();
      const sentinel = builtin._load;
      if (sentinel === undefined) throw new Error('Module._load is unavailable');
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.resetModules();
        const { installNativeModuleHook } = await import('#/native/module-hook');

        installNativeModuleHook();
        expect(writeSpy).toHaveBeenCalledTimes(1);
        const message = String(writeSpy.mock.calls[0]?.[0]);
        expect(message).toMatch(/[Bb]un/);
        expect(message).toContain('checksum mismatch');
        expect(builtin._load).toBe(sentinel);
      } finally {
        writeSpy.mockRestore();
        builtin._load = sentinel;
      }
    });
  });
});
