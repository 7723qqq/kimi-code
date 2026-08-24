import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getTextBuildWorkerRuntimeState,
  resetTextBuildWorkerRuntime,
} from '@moonshot-ai/minidb/worker-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBunEmbeddedAssetSource } from '#/native/bun-assets';
import { installMinidbTextBuildWorker } from '#/native/minidb-worker';
import {
  ensureNodePtyBindingForBun,
  ensurePiTuiNativeHelperForBun,
  getEmbeddedNativeAssetManifest,
  getMinidbTextBuildWorkerFile,
  getNativeCacheBase,
  getNativePackageRoot,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
  type NodePtyBindingOptions,
  type PiTuiHelperOptions,
} from '#/native/native-assets';
import { loadNativePackage } from '#/native/native-require';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(
  files: Record<string, string>,
  workerContent?: string,
): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const assetEntries = Object.entries(files).map(([relativePath, content]) => {
    const assetKey = `native/test-target/${relativePath}`;
    return {
      assetKey,
      relativePath,
      sha256: sha256(content),
    };
  });
  const manifestKey = 'native/test-target/manifest.json';
  const workerAssetKey = 'native/test-target/runtime/minidb-text-build-worker';
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [
      {
        name: 'fake-native',
        root: 'node_modules/fake-native',
        files: assetEntries,
      },
    ],
    runtimeFiles:
      workerContent === undefined
        ? []
        : [
            {
              key: 'minidb-text-build-worker',
              assetKey: workerAssetKey,
              relativePath: 'runtime/minidb/text-build-worker.mjs',
              sha256: sha256(workerContent),
              mode: 0o644,
            },
          ],
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(
      ([relativePath, content]) =>
        [`native/test-target/${relativePath}`, Buffer.from(content)] as const,
    ),
    ...(workerContent === undefined ? [] : [[workerAssetKey, Buffer.from(workerContent)] as const]),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

function sourceForManifest(manifest: unknown): NativeAssetSource {
  const key = 'native/test-target/manifest.json';
  return {
    getAssetKeys: () => [key],
    getRawAsset: (assetKey) => {
      if (assetKey !== key) throw new Error(`missing test asset: ${assetKey}`);
      return Buffer.from(JSON.stringify(manifest));
    },
  };
}

afterEach(() => {
  resetTextBuildWorkerRuntime();
});

describe('native assets', () => {
  it('uses KIMI_CODE_CACHE_DIR as the native cache base when present', () => {
    expect(
      getNativeCacheBase({
        env: { KIMI_CODE_CACHE_DIR: '/tmp/kimi-cache' },
        homeDir: '/home/kimi',
        platform: 'linux',
      }),
    ).toBe('/tmp/kimi-cache');
  });

  it('extracts package assets and repairs corrupted cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-assets-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const packageRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(packageRoot).toBe(
        join(
          dir,
          'native',
          'test',
          'test-target',
          sha256(JSON.stringify(manifest)),
          'node_modules',
          'fake-native',
        ),
      );
      expect(readFileSync(join(packageRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");

      writeFileSync(join(packageRoot ?? '', 'index.js'), 'broken');
      const repairedRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(repairedRoot).toBe(packageRoot);
      expect(readFileSync(join(repairedRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");
      expect(existsSync(join(dir, 'native', 'test', 'test-target'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a package from extracted native assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-require-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const pkg = loadNativePackage<{ value: string }>('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(pkg).toEqual({ value: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts, reuses, and repairs the runtime worker in the unified cache tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-'));
    try {
      const worker = 'export const worker = true;\n';
      const { manifest, source } = fakeManifest(
        { 'node_modules/fake-native/package.json': '{"main":"index.js"}' },
        worker,
      );
      const options = { cacheBase: dir, manifest, source, version: 'test' };
      const first = getMinidbTextBuildWorkerFile(options);
      const packageRoot = getNativePackageRoot('fake-native', options);
      expect(first).toBe(
        join(
          dir,
          'native',
          'test',
          'test-target',
          sha256(JSON.stringify(manifest)),
          'runtime',
          'minidb',
          'text-build-worker.mjs',
        ),
      );
      expect(packageRoot?.startsWith(join(dir, 'native', 'test', 'test-target'))).toBe(true);
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);

      writeFileSync(first!, 'corrupt');
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);
      expect(readFileSync(first!, 'utf-8')).toBe(worker);

      const installed = installMinidbTextBuildWorker(options);
      expect(installed).toMatchObject({ status: 'installed', assetSha256: sha256(worker) });
      expect(getTextBuildWorkerRuntimeState()).toMatchObject({
        configured: true,
        entry: { kind: 'packaged', path: first },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing and corrupt runtime worker assets without configuring MiniDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-fail-'));
    try {
      const missing = fakeManifest({});
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: missing.manifest,
          source: missing.source,
          version: 'test',
        }),
      ).toEqual({ status: 'asset-missing' });

      const corrupt = fakeManifest({}, 'worker');
      const corruptSource: NativeAssetSource = {
        getAssetKeys: () => corrupt.source.getAssetKeys(),
        getRawAsset: (key) =>
          key.endsWith('/runtime/minidb-text-build-worker')
            ? Buffer.from('wrong')
            : corrupt.source.getRawAsset(key),
      };
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: corrupt.manifest,
          source: corruptSource,
          version: 'test',
        }),
      ).toMatchObject({ status: 'failed', errorCode: 'Error' });
      expect(getTextBuildWorkerRuntimeState()).toEqual({ configured: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported or structurally incomplete native manifest versions', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const cases: Array<{ manifest: unknown; error: RegExp }> = [
      { manifest: { ...valid, version: 1 }, error: /Unsupported native asset manifest version: 1/ },
      {
        manifest: {
          version: NATIVE_ASSET_MANIFEST_VERSION,
          target: 'test-target',
          runtimeFiles: [],
        },
        error: /packages must be an array/,
      },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target', packages: [] },
        error: /runtimeFiles must be an array/,
      },
      { manifest: { ...valid, packages: {} }, error: /packages must be an array/ },
      { manifest: { ...valid, runtimeFiles: {} }, error: /runtimeFiles must be an array/ },
    ];

    for (const item of cases) {
      expect(() =>
        getEmbeddedNativeAssetManifest(sourceForManifest(item.manifest), 'test-target'),
      ).toThrow(item.error);
    }
  });

  it('rejects unsafe paths, invalid file metadata, and duplicate manifest keys', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const worker = valid.runtimeFiles[0]!;
    const invalidRuntimeFiles: Array<{ file: Record<string, unknown>; error: RegExp }> = [
      { file: { ...worker, relativePath: '/tmp/worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: '../worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: 'runtime\\..\\worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, sha256: 'not-a-sha' }, error: /64 lowercase hex/ },
      { file: { ...worker, mode: 0o1000 }, error: /mode must be an integer/ },
      { file: { ...worker, assetKey: 42 }, error: /assetKey must be a non-empty string/ },
    ];
    for (const item of invalidRuntimeFiles) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest({ ...valid, runtimeFiles: [item.file] }),
          'test-target',
        ),
      ).toThrow(item.error);
    }

    const validPackage = valid.packages[0]!;
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, root: '../node_modules/fake-native' }],
        }),
        'test-target',
      ),
    ).toThrow(/safe relative path/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, files: {} }],
        }),
        'test-target',
      ),
    ).toThrow(/files must be an array/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            {
              ...worker,
              assetKey: 'native/test-target/runtime/other',
              relativePath: 'runtime/other.mjs',
            },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate runtime key/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            {
              ...worker,
              key: 'other',
              relativePath: 'runtime/other.mjs',
            },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate assetKey/);
  });
});

describe('bun embedded assets', () => {
  const bunGlobal = globalThis as unknown as { __KIMI_BUN_ASSETS__?: Record<string, string> };

  beforeEach(() => {
    delete bunGlobal.__KIMI_BUN_ASSETS__;
  });

  afterEach(() => {
    delete bunGlobal.__KIMI_BUN_ASSETS__;
  });

  it('returns null when the Bun asset global is missing or empty', () => {
    expect(getBunEmbeddedAssetSource()).toBeNull();
    bunGlobal.__KIMI_BUN_ASSETS__ = {};
    expect(getBunEmbeddedAssetSource()).toBeNull();
  });

  it('exposes asset keys and raw file contents from mapped paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-bun-assets-'));
    try {
      const textPath = join(dir, 'worker.mjs');
      const binaryPath = join(dir, 'native.bin');
      const worker = 'export const worker = true;\n';
      const binary = Buffer.from([0x00, 0xff, 0x10, 0xfe]);
      writeFileSync(textPath, worker, 'utf-8');
      writeFileSync(binaryPath, binary);

      bunGlobal.__KIMI_BUN_ASSETS__ = {
        'native/test-target/runtime/worker': textPath,
        'native/test-target/native.bin': binaryPath,
      };

      const source = getBunEmbeddedAssetSource();
      expect(source).not.toBeNull();
      expect(source!.getAssetKeys()).toEqual([
        'native/test-target/runtime/worker',
        'native/test-target/native.bin',
      ]);
      expect(source!.getRawAsset('native/test-target/runtime/worker')).toEqual(
        Buffer.from(worker, 'utf-8'),
      );
      expect(source!.getRawAsset('native/test-target/native.bin')).toEqual(binary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when looking up an unknown asset key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-bun-assets-unknown-'));
    try {
      const path = join(dir, 'asset.txt');
      writeFileSync(path, 'ok');
      bunGlobal.__KIMI_BUN_ASSETS__ = { 'native/known': path };

      const source = getBunEmbeddedAssetSource()!;
      expect(() => source.getRawAsset('native/missing')).toThrow(/Unknown Bun embedded asset/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensurePiTuiNativeHelperForBun', () => {
  const HELPER_CONTENT = 'fake-node-helper-bytes';
  const PI_TUI_ROOT = 'node_modules/@moonshot-ai/pi-tui';

  function piTuiSource(files: string[], packageName = '@moonshot-ai/pi-tui'): NativeAssetSource {
    const entries = files.map((relativePath) => ({
      assetKey: `native/test-target/${PI_TUI_ROOT}/${relativePath}`,
      relativePath: `${PI_TUI_ROOT}/${relativePath}`,
      sha256: sha256(HELPER_CONTENT),
    }));
    const manifest: NativeAssetManifest = {
      version: NATIVE_ASSET_MANIFEST_VERSION,
      target: 'test-target',
      packages: [{ name: packageName, root: PI_TUI_ROOT, files: entries }],
      runtimeFiles: [],
    };
    const assets = new Map<string, Buffer>([
      ['native/test-target/manifest.json', Buffer.from(JSON.stringify(manifest))],
      ...entries.map((entry) => [entry.assetKey, Buffer.from(HELPER_CONTENT)] as const),
    ]);
    return {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    };
  }

  function helperOptions(
    dir: string,
    overrides: Partial<PiTuiHelperOptions> = {},
  ): PiTuiHelperOptions {
    return {
      source: piTuiSource([]),
      target: 'test-target',
      platform: 'linux',
      arch: 'x64',
      bundleDir: dir,
      ...overrides,
    };
  }

  it('writes the darwin helper next to the bundle dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pitui-helper-'));
    try {
      const ok = ensurePiTuiNativeHelperForBun(
        helperOptions(dir, {
          source: piTuiSource(['native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node']),
          platform: 'darwin',
          arch: 'arm64',
        }),
      );
      expect(ok).toBe(true);
      const helperPath = join(dir, 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node');
      expect(readFileSync(helperPath, 'utf-8')).toBe(HELPER_CONTENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the win32 console-mode helper for win32 targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pitui-helper-'));
    try {
      const ok = ensurePiTuiNativeHelperForBun(
        helperOptions(dir, {
          source: piTuiSource(['native/win32/prebuilds/win32-x64/win32-console-mode.node']),
          platform: 'win32',
          arch: 'x64',
        }),
      );
      expect(ok).toBe(true);
      const helperPath = join(dir, 'native/win32/prebuilds/win32-x64/win32-console-mode.node');
      expect(readFileSync(helperPath, 'utf-8')).toBe(HELPER_CONTENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op on platforms and arches without a pi-tui helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pitui-helper-'));
    try {
      expect(ensurePiTuiNativeHelperForBun(helperOptions(dir))).toBe(true);
      expect(existsSync(join(dir, 'native'))).toBe(false);

      expect(
        ensurePiTuiNativeHelperForBun(helperOptions(dir, { platform: 'darwin', arch: 'arm' })),
      ).toBe(true);
      expect(existsSync(join(dir, 'native'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op outside the compiled Bun binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pitui-helper-'));
    try {
      expect(ensurePiTuiNativeHelperForBun(helperOptions(dir, { source: null }))).toBe(true);
      expect(existsSync(join(dir, 'native'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the embedded assets carry no usable helper', () => {
    const noHelperFile = ensurePiTuiNativeHelperForBun(
      helperOptions('/kimi-unused-bundle-dir', {
        source: piTuiSource(['package.json']),
        platform: 'darwin',
        arch: 'arm64',
      }),
    );
    expect(noHelperFile).toBe(false);

    const noPackage = ensurePiTuiNativeHelperForBun(
      helperOptions('/kimi-unused-bundle-dir', {
        source: piTuiSource(
          ['native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node'],
          '@moonshot-ai/other-package',
        ),
        platform: 'darwin',
        arch: 'arm64',
      }),
    );
    expect(noPackage).toBe(false);
  });

  it('throws when the embedded helper fails checksum verification', () => {
    const source = piTuiSource(['native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node']);
    const tampered = {
      getAssetKeys: source.getAssetKeys,
      getRawAsset: (assetKey: string): Buffer => {
        if (assetKey.endsWith('darwin-modifiers.node')) return Buffer.from('tampered-bytes');
        return source.getRawAsset(assetKey) as Buffer;
      },
    };
    expect(() =>
      ensurePiTuiNativeHelperForBun({
        source: tampered,
        target: 'test-target',
        platform: 'darwin',
        arch: 'arm64',
        bundleDir: '/kimi-unused-bundle-dir',
      }),
    ).toThrow(/checksum mismatch/);
  });
});

describe('ensureNodePtyBindingForBun', () => {
  const NODE_PTY_ROOT = 'node_modules/node-pty';

  function nodePtySource(files: string[]): NativeAssetSource {
    const entries = files.map((relativePath) => ({
      assetKey: `native/test-target/${NODE_PTY_ROOT}/${relativePath}`,
      relativePath: `${NODE_PTY_ROOT}/${relativePath}`,
      sha256: sha256('fake-pty-binding-bytes'),
    }));
    const manifest: NativeAssetManifest = {
      version: NATIVE_ASSET_MANIFEST_VERSION,
      target: 'test-target',
      packages: [{ name: 'node-pty', root: NODE_PTY_ROOT, files: entries }],
      runtimeFiles: [],
    };
    const assets = new Map<string, Buffer>([
      ['native/test-target/manifest.json', Buffer.from(JSON.stringify(manifest))],
      ...entries.map((entry) => [
        entry.assetKey,
        Buffer.from('fake-pty-binding-bytes'),
      ] as const),
    ]);
    return {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    };
  }

  function bindingOptions(
    dir: string,
    overrides: Partial<NodePtyBindingOptions> = {},
  ): NodePtyBindingOptions {
    return {
      source: nodePtySource([]),
      target: 'test-target',
      bundleDir: dir,
      ...overrides,
    };
  }

  it('extracts the binding tree under the bundle dir without the package-root prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-nodepty-binding-'));
    try {
      const ok = ensureNodePtyBindingForBun(
        bindingOptions(dir, {
          source: nodePtySource([
            'prebuilds/win32-x64/pty.node',
            'prebuilds/win32-x64/conpty/conpty.dll',
          ]),
        }),
      );
      expect(ok).toBe(true);
      expect(readFileSync(join(dir, 'prebuilds/win32-x64/pty.node'), 'utf-8')).toBe(
        'fake-pty-binding-bytes',
      );
      expect(readFileSync(join(dir, 'prebuilds/win32-x64/conpty/conpty.dll'), 'utf-8')).toBe(
        'fake-pty-binding-bytes',
      );
      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op outside the compiled Bun binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-nodepty-binding-'));
    try {
      expect(ensureNodePtyBindingForBun(bindingOptions(dir, { source: null }))).toBe(true);
      expect(existsSync(join(dir, 'prebuilds'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the embedded assets carry no node-pty package', () => {
    const dir = '/kimi-unused-bundle-dir';
    expect(ensureNodePtyBindingForBun(bindingOptions(dir))).toBe(false);

    const emptyPackage = nodePtySource([]);
    const noFiles = ensureNodePtyBindingForBun({
      source: { getAssetKeys: emptyPackage.getAssetKeys, getRawAsset: emptyPackage.getRawAsset },
      target: 'test-target',
      bundleDir: dir,
    });
    expect(noFiles).toBe(false);
  });

  it('throws when an embedded binding fails checksum verification', () => {
    const source = nodePtySource(['prebuilds/win32-x64/pty.node']);
    const tampered = {
      getAssetKeys: source.getAssetKeys,
      getRawAsset: (assetKey: string): Buffer => {
        if (assetKey.endsWith('pty.node')) return Buffer.from('tampered-bytes');
        return source.getRawAsset(assetKey) as Buffer;
      },
    };
    expect(() =>
      ensureNodePtyBindingForBun({
        source: tampered,
        target: 'test-target',
        bundleDir: '/kimi-unused-bundle-dir',
      }),
    ).toThrow(/checksum mismatch/);
  });
});
