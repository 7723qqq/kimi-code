/**
 * Kimi Code version helpers.
 *
 * `getVersion` returns the build-time injected version when present, and
 * otherwise falls back to reading the host CLI's `package.json#version`.
 */

import { createKimiUserAgent, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth/identity';

import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { getVersion } from './version-info';

export { getHostPackageJsonPath, getHostPackageRoot, getVersion } from './version-info';

export function createKimiCodeHostIdentity(version = getVersion()): KimiHostIdentity {
  return {
    productName: CLI_USER_AGENT_PRODUCT,
    version,
    platform: CLI_MSH_PLATFORM,
  };
}

/**
 * Product User-Agent (`kimi-code-cli/<version>`) for ad-hoc outbound fetches
 * that don't go through the provider pipeline (registry / catalog imports).
 */
export function createKimiCodeUserAgent(version = getVersion()): string {
  return createKimiUserAgent(createKimiCodeHostIdentity(version));
}
