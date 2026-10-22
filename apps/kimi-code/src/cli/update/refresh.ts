import type { RenderClock } from '#/tui/utils/render-clock';

import { writeUpdateCache } from './cache';
import { fetchLatestFromCdn, type FetchLatestResult } from './cdn';
import { type UpdateCache } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the latest version + rollout manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient CDN blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<FetchLatestResult>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
  readonly timeoutMs?: number;
  /** Clock for the default CDN fetch's request timeout; defaults to the system clock. */
  readonly clock?: RenderClock;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest:
      overrides.fetchLatest ??
      (() => fetchLatestFromCdn(undefined, overrides.timeoutMs, overrides.clock)),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  const { latest, manifest } = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'cdn',
    checkedAt: resolved.now().toISOString(),
    latest,
    manifest,
  };
  await resolved.writeCache(cache);
  return cache;
}
