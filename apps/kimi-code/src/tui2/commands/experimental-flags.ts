/**
 * Resolved experimental feature flags — a local cache fetched once from the
 * core over RPC at startup and read synchronously by the command palette and
 * dispatch. App-local cache, not a source of truth.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */
import type { ExperimentalFeatureState, ExperimentalFlagMap } from '@moonshot-ai/kimi-code-sdk';

import { experimentalFeatureMap } from '#/utils/experimental-features';

let snapshot: ExperimentalFlagMap = {};

/** Replace the cached flag snapshot. Call after fetching via `harness.getExperimentalFeatures()`. */
export function setExperimentalFeatures(
  features: readonly Pick<ExperimentalFeatureState, 'id' | 'enabled'>[],
): void {
  snapshot = experimentalFeatureMap(features);
}

/** An `undefined` flag means "not gated" → always enabled, so callers can pass an optional flag id. */
export function isExperimentalFlagEnabled(flag: string | undefined): boolean {
  return flag === undefined || snapshot[flag] === true;
}
