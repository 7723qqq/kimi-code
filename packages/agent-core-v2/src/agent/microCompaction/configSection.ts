/**
 * `microCompaction` domain (L4) - micro-compaction config-section schema.
 *
 * Owns the `[micro_compaction]` tuning section consumed by
 * `AgentMicroCompactionService`. Self-registered at module load via
 * `registerConfigSection`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MICRO_COMPACTION_SECTION = 'microCompaction';

const microCompactionConfigShape = {
  keepRecentMessages: z.number().int().min(0),
  minContentTokens: z.number().int().min(0),
  cacheMissedThresholdMs: z.number().int().min(0),
  truncatedMarker: z.string(),
  minContextUsageRatio: z.number().min(0).max(1),
};

const microCompactionConfigObject = z.object(microCompactionConfigShape);

export type MicroCompactionConfig = z.infer<typeof microCompactionConfigObject>;

export const MicroCompactionConfigSchema = microCompactionConfigObject.partial();

export type MicroCompactionConfigPatch = z.infer<typeof MicroCompactionConfigSchema>;

registerConfigSection(MICRO_COMPACTION_SECTION, MicroCompactionConfigSchema);
