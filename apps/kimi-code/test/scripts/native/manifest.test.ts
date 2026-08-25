import { describe, expect, it } from 'vitest';

import {
  NATIVE_ASSET_MANIFEST_VERSION,
  WEB_ASSET_MANIFEST_VERSION,
  buildAssetKey,
  buildManifestKey,
  buildRuntimeAssetKey,
  buildWebAssetKey,
  buildWebManifestKey,
  isManifestVersionSupported,
} from '../../../scripts/native/manifest.mjs';

describe('NATIVE_ASSET_MANIFEST_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
    expect(NATIVE_ASSET_MANIFEST_VERSION).toBeGreaterThan(0);
  });
});

describe('WEB_ASSET_MANIFEST_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(WEB_ASSET_MANIFEST_VERSION)).toBe(true);
    expect(WEB_ASSET_MANIFEST_VERSION).toBeGreaterThan(0);
  });
});

describe('buildManifestKey', () => {
  it('namespaces by target', () => {
    expect(buildManifestKey('darwin-arm64')).toBe('native/darwin-arm64/manifest.json');
    expect(buildManifestKey('linux-x64')).toBe('native/linux-x64/manifest.json');
  });
});

describe('buildRuntimeAssetKey', () => {
  it('namespaces runtime files under the target', () => {
    expect(buildRuntimeAssetKey('darwin-arm64', 'kap-search-worker')).toBe(
      'native/darwin-arm64/runtime/kap-search-worker',
    );
  });
});

describe('buildAssetKey', () => {
  it('namespaces package files under the target and package root', () => {
    expect(buildAssetKey('linux-x64', 'node_modules/fake-native', 'index.js')).toBe(
      'native/linux-x64/node_modules/fake-native/index.js',
    );
  });
});

describe('isManifestVersionSupported', () => {
  it('accepts current version', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
  });

  it('rejects other versions', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION + 1)).toBe(false);
    expect(isManifestVersionSupported(0)).toBe(false);
  });
});

describe('web asset keys', () => {
  it('namespaces manifests and files under web/<target>', () => {
    expect(buildWebManifestKey('darwin-arm64')).toBe('web/darwin-arm64/manifest.json');
    expect(buildWebAssetKey('darwin-arm64', 'index.html')).toBe(
      'web/darwin-arm64/dist-web/index.html',
    );
  });
});
