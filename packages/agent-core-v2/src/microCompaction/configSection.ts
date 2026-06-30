/**
 * `microCompaction` domain (L4) - micro-compaction config-section schema.
 *
 * Owns the `[micro_compaction]` tuning section consumed by
 * `MicroCompactionService`. Registered into `IConfigRegistry` by the
 * micro-compaction service on construction.
 */

import { z } from 'zod';

export const MICRO_COMPACTION_SECTION = 'microCompaction';

export const MicroCompactionConfigSchema = z.object({
  keepRecentMessages: z.number().int().min(0).optional(),
  minContentTokens: z.number().int().min(0).optional(),
  cacheMissedThresholdMs: z.number().int().min(0).optional(),
  truncatedMarker: z.string().optional(),
  minContextUsageRatio: z.number().min(0).max(1).optional(),
});

export type MicroCompactionConfigPatch = z.infer<typeof MicroCompactionConfigSchema>;
