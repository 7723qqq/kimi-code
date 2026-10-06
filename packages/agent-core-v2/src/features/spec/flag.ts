import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { SPEC_MODE_FLAG_ID } from './spec';

export const SPEC_MODE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SPEC_MODE';

export const specModeFlag: FlagDefinitionInput = {
  id: SPEC_MODE_FLAG_ID,
  title: 'Spec mode',
  description:
    'Write a committed spec (requirements, design, tasks) before implementing, with writes restricted to the spec directory until you approve it.',
  env: SPEC_MODE_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(specModeFlag);
