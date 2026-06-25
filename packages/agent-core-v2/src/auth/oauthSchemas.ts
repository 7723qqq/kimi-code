/**
 * `auth` domain (cross-cutting) — config schemas for OAuth providers.
 *
 * Owns the `providers` config-section schema consumed by `OAuthService` (and,
 * later, by the `kosong` provider manager). The `OAuthRef` / `ProviderConfig` /
 * `ProviderType` models are shared with the `config` domain (see
 * `config/schema.ts`) so the same `config.toml` stays compatible across the
 * two engines; the snake_case TOML mapping is handled by the `config`
 * persistence layer, not here.
 */

import { z } from 'zod';

import {
  type OAuthRef,
  OAuthRefSchema,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderType,
  ProviderTypeSchema,
} from '#/config/schema';

export { OAuthRefSchema, ProviderConfigSchema, ProviderTypeSchema };
export type { OAuthRef, ProviderConfig, ProviderType };

export const PROVIDERS_SECTION = 'providers';

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

export type ProvidersSection = z.infer<typeof ProvidersSectionSchema>;
