/**
 * `microCompaction` domain — flag contribution.
 *
 * Registers the `micro_compaction` experimental flag at import time, so the
 * flag is available process-wide before any consumer resolves `IFlagService`.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag';

export const microCompactionFlag: FlagDefinitionInput = {
  id: 'micro_compaction',
  title: 'Micro compaction',
  description:
    'Trim older large tool results from context while keeping recent conversation intact.',
  env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
  default: true,
  surface: 'core',
};

registerFlagDefinition(microCompactionFlag);
