import { describe, expect, it } from 'bun:test';

import { loadClipboardModule, type ClipboardModule } from '#/utils/clipboard/clipboard-native';

function nativeModule(): ClipboardModule {
  return {
    hasImage: () => true,
    getImageBinary: async () => [1, 2, 3],
  };
}

describe('loadClipboardModule', () => {
  it('returns null on Termux', () => {
    let loads = 0;
    const loaded = loadClipboardModule({
      platform: 'linux',
      env: { TERMUX_VERSION: '0.118.0' },
      loadNativePackage: () => {
        loads += 1;
        return nativeModule();
      },
    });

    expect(loaded).toBeNull();
    expect(loads).toBe(0);
  });

  it('skips the load on Linux without a display', () => {
    let loads = 0;
    const loaded = loadClipboardModule({
      platform: 'linux',
      env: {},
      loadNativePackage: () => {
        loads += 1;
        return nativeModule();
      },
    });

    expect(loaded).toBeNull();
    expect(loads).toBe(0);
  });

  it('loads on Linux when a display is configured', () => {
    const clip = nativeModule();
    const loaded = loadClipboardModule({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      loadNativePackage: () => clip,
    });

    expect(loaded).toBe(clip);
  });

  it('returns the bundled native package when it loads', () => {
    const clip = nativeModule();
    let requires = 0;
    const loaded = loadClipboardModule({
      platform: 'darwin',
      env: {},
      loadNativePackage: () => clip,
      requirePackage: () => {
        requires += 1;
        return clip;
      },
    });

    expect(loaded).toBe(clip);
    expect(requires).toBe(0);
  });

  it('falls back to require when no bundled package is available', () => {
    const clip = nativeModule();
    const loaded = loadClipboardModule({
      platform: 'darwin',
      env: {},
      isNativeBundle: false,
      loadNativePackage: () => null,
      requirePackage: () => clip,
    });

    expect(loaded).toBe(clip);
  });

  it('does not require a package outside the native bundle until the bundle is missing', () => {
    let requires = 0;
    const loaded = loadClipboardModule({
      platform: 'darwin',
      env: {},
      isNativeBundle: true,
      loadNativePackage: () => null,
      requirePackage: () => {
        requires += 1;
        return nativeModule();
      },
    });

    expect(loaded).toBeNull();
    expect(requires).toBe(0);
  });

  it('returns null when the bundled loader throws', () => {
    let requires = 0;
    const loaded = loadClipboardModule({
      platform: 'darwin',
      env: {},
      isNativeBundle: false,
      loadNativePackage: () => {
        throw new Error('binding failed to initialize');
      },
      requirePackage: () => {
        requires += 1;
        return nativeModule();
      },
    });

    expect(loaded).toBeNull();
    expect(requires).toBe(0);
  });

  it('returns null when the require fallback throws', () => {
    const loaded = loadClipboardModule({
      platform: 'darwin',
      env: {},
      isNativeBundle: false,
      loadNativePackage: () => null,
      requirePackage: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });

    expect(loaded).toBeNull();
  });
});
