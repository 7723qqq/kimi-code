/**
 * Shared manifest constants and key builders for native / web asset manifests.
 *
 * The native manifest version is maintained by the build scripts
 * (scripts/native/manifest.mjs); production code in src/native/ imports it
 * directly from there, because those scripts run as plain .mjs without
 * TypeScript compilation. The constants in this file are consumed by the web
 * asset path (web-assets.ts) only — keep NATIVE_ASSET_MANIFEST_VERSION in sync
 * with manifest.mjs.
 */

export const NATIVE_ASSET_MANIFEST_VERSION = 2;
export const WEB_ASSET_MANIFEST_VERSION = 1;

export function buildManifestKey(target: string): string {
  return `native/${target}/manifest.json`;
}

export function isManifestVersionSupported(version: number): boolean {
  return version === NATIVE_ASSET_MANIFEST_VERSION;
}

export function buildAssetKey(target: string, packageRoot: string, relativePath: string): string {
  return `native/${target}/${packageRoot}/${relativePath}`;
}

export function buildWebManifestKey(target: string): string {
  return `web/${target}/manifest.json`;
}

export function buildWebAssetKey(target: string, relativePath: string): string {
  return `web/${target}/dist-web/${relativePath}`;
}
