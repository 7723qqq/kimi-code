/**
 * `profile` domain (L4) — `thinking` config-section schema.
 *
 * Owns the `[thinking]` configuration section (mode / effort) consumed by
 * `ProfileService` to resolve the effective thinking effort. Registered into
 * `IConfigRegistry` by `ProfileService` on construction.
 */

import { z } from 'zod';

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  effort: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
