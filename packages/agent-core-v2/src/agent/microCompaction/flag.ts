/**
 * `microCompaction` domain — registers the `micro-compaction` experimental
 * flag into `flag`.
 *
 * Gates cache-miss micro compaction: after the prompt cache misses, old
 * oversized tool results are replaced with a marker in the outgoing request.
 * Off by default; enable via `KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION`, the
 * master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MICRO_COMPACTION_FLAG_ID = 'micro_compaction';
export const MICRO_COMPACTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION';

export const microCompactionFlag: FlagDefinitionInput = {
  id: MICRO_COMPACTION_FLAG_ID,
  title: 'Micro compaction (cache-miss tool-result truncation)',
  description:
    'After a prompt-cache miss, replace old oversized tool results in the outgoing request with a marker so the rebuilt prefix stays small.',
  env: MICRO_COMPACTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(microCompactionFlag);
