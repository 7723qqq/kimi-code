import { valid } from 'semver';
import { z } from 'zod';

import { kimiCodeCdnLatestJsonUrl, kimiCodeCdnLatestUrl } from '#/constant/app';
import { SYSTEM_RENDER_CLOCK, type RenderClock } from '#/tui/utils/render-clock';

import type { UpdateManifest } from './types';

const CDN_FETCH_TIMEOUT_MS = 3_000;

const RolloutBatchSchema = z.object({
  percent: z.number().int().min(0).max(100),
  delaySeconds: z.number().int().min(0),
});

/**
 * CDN `latest.json` wire format. Deliberately NOT `.strict()` — unknown
 * fields are ignored so future manifest additions never break shipped
 * clients (the plain-text `/latest` taught us that hard-failing on
 * unexpected content bricks the update path forever).
 */
export const UpdateManifestSchema = z.object({
  version: z.string().refine((value) => valid(value) !== null, { error: 'invalid semver' }),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), { error: 'invalid timestamp' }),
  rollout: z.array(RolloutBatchSchema).readonly().default([]),
});

export interface FetchLatestResult {
  /** Raw newest version — what `kimi upgrade` installs, never rollout-gated. */
  readonly latest: string;
  /** Null when the JSON manifest was unavailable and we fell back to plain text. */
  readonly manifest: UpdateManifest | null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
  clock: RenderClock,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = clock.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { signal: controller.signal });
  } finally {
    clock.clearTimeout(timeout);
  }
}

/**
 * Fetch the latest published Kimi Code version from the CDN.
 *
 * **Throws** on any failure (network error, non-2xx, empty body, non-semver
 * text). Callers must catch — `refreshUpdateCache` deliberately lets the
 * error propagate so the existing cache stays intact instead of being
 * overwritten with a null `latest` on a transient blip.
 *
 * `fetchImpl` and `clock` are injectable for tests; they default to the global
 * `fetch` and the system clock.
 */
export async function fetchLatestVersionFromCdn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
  clock: RenderClock = SYSTEM_RENDER_CLOCK,
): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, kimiCodeCdnLatestUrl(), timeoutMs, clock);
  if (!response.ok) {
    throw new Error(`CDN /latest returned HTTP ${response.status}`);
  }
  const raw = (await response.text()).trim();
  if (valid(raw) === null) {
    throw new Error(`CDN /latest returned invalid semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}

async function fetchUpdateManifestFromCdn(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  clock: RenderClock,
): Promise<UpdateManifest> {
  const response = await fetchWithTimeout(
    fetchImpl,
    kimiCodeCdnLatestJsonUrl(),
    timeoutMs,
    clock,
  );
  if (!response.ok) {
    throw new Error(`CDN /latest.json returned HTTP ${response.status}`);
  }
  return UpdateManifestSchema.parse(JSON.parse(await response.text()));
}

/**
 * Fetch the rollout manifest, falling back to the plain-text `/latest` when
 * `latest.json` is unavailable or malformed. The fallback removes any
 * deployment-order coupling between client releases and the CDN file, and a
 * null manifest means "fully rolled out" — exactly the pre-rollout behavior.
 *
 * **Throws** only when both sources fail; callers must catch (see above).
 */
export async function fetchLatestFromCdn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
  clock: RenderClock = SYSTEM_RENDER_CLOCK,
): Promise<FetchLatestResult> {
  const manifest = await fetchUpdateManifestFromCdn(fetchImpl, timeoutMs, clock).catch(() => null);
  if (manifest !== null) {
    return { latest: manifest.version, manifest };
  }
  const latest = await fetchLatestVersionFromCdn(fetchImpl, timeoutMs, clock);
  return { latest, manifest: null };
}
