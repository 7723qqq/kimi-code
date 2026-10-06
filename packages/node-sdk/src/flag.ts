import type {
  FlagDefinitionInput,
  FlagId,
} from '@moonshot-ai/agent-core-v2';

export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
} from '@moonshot-ai/agent-core-v2';
export type {
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@moonshot-ai/agent-core-v2';

export type FlagDefinition = FlagDefinitionInput & { readonly id: FlagId };
