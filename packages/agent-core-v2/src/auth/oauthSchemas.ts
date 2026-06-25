/**
 * `auth` domain (cross-cutting) — config schemas for OAuth providers.
 *
 * Owns the `providers` config-section schema and the `OAuthRef` /
 * `ProviderConfig` models consumed by `OAuthService` (and, later, by the
 * `kosong` provider manager). Field names and types mirror
 * `packages/agent-core/src/config/schema.ts` so the same `config.toml` stays
 * compatible across the two engines; the snake_case TOML mapping is handled by
 * the `config` persistence layer, not here.
 */

import { z } from 'zod';

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export type OAuthRef = z.infer<typeof OAuthRefSchema>;

const StringRecordSchema = z.record(z.string(), z.string());

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PROVIDERS_SECTION = 'providers';

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

export type ProvidersSection = z.infer<typeof ProvidersSectionSchema>;
