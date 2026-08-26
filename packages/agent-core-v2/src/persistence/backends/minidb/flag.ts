import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PERSISTENCE_MINIDB_READMODEL_FLAG_ID = 'persistence_minidb_readmodel';
export const PERSISTENCE_MINIDB_READMODEL_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL';

export const persistenceMiniDbReadModelFlag: FlagDefinitionInput = {
  id: PERSISTENCE_MINIDB_READMODEL_FLAG_ID,
  title: 'minidb read model',
  description:
    'Use the minidb-backed IQueryStore as a derived read model for session indexing and wire replay.',
  env: PERSISTENCE_MINIDB_READMODEL_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(persistenceMiniDbReadModelFlag);
