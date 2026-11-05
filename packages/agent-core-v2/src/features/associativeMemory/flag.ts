import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const ASSOCIATIVE_MEMORY_FLAG_ID = 'associative_memory';
export const ASSOCIATIVE_MEMORY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_ASSOCIATIVE_MEMORY';

export const associativeMemoryFlag: FlagDefinitionInput = {
  id: ASSOCIATIVE_MEMORY_FLAG_ID,
  title: 'Associative memory',
  description:
    'Encode experience into atoms, learn weighted associations, and inject related memories on each turn.',
  env: ASSOCIATIVE_MEMORY_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(associativeMemoryFlag);
