import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const GIT_MEMORY_FLAG_ID = 'git_memory';
export const GIT_MEMORY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_GIT_MEMORY';

export const gitMemoryFlag: FlagDefinitionInput = {
  id: GIT_MEMORY_FLAG_ID,
  title: 'Git memory',
  description:
    'Distil local git history into structured facts and inject them into the agent context.',
  env: GIT_MEMORY_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(gitMemoryFlag);
