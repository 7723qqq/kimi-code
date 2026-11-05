import type { RenderClock } from '#/utils/render-clock';

import { writeUpdateCache } from './cache';
import { fetchChannelFeed, type ChannelFeed } from './cdn';
import { type UpdateCache, type UpdateChannel } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the channel's latest version + manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient CDN blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<Omit<ChannelFeed, 'channel'>>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
  readonly channel: UpdateChannel;
  readonly timeoutMs?: number;
  /** Clock for the default CDN fetch's request timeout; defaults to the system clock. */
  readonly clock?: RenderClock;
}

export type RefreshUpdateCacheOptions = Partial<RefreshUpdateCacheDeps> & {
  readonly channel: UpdateChannel;
};

export async function refreshUpdateCache(
  overrides: RefreshUpdateCacheOptions,
): Promise<UpdateCache> {
  const channel = overrides.channel;
  const resolved = {
    fetchLatest:
      overrides.fetchLatest ??
      (() => fetchChannelFeed(channel, undefined, overrides.timeoutMs, overrides.clock)),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  const { latest, manifest } = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'cdn',
    channel,
    checkedAt: resolved.now().toISOString(),
    latest,
    manifest,
  };
  await resolved.writeCache(cache);
  return cache;
}
