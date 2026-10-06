import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { PROMPT_OPTIMIZER_FLAG_ENV, PROMPT_OPTIMIZER_FLAG_ID } from './promptOptimizer';

export const promptOptimizerFlag: FlagDefinitionInput = {
  id: PROMPT_OPTIMIZER_FLAG_ID,
  title: 'Prompt optimizer',
  description:
    'Let the input box rewrite a drafted prompt through the current model, reaching it from the TUI shortcut and the session API.',
  env: PROMPT_OPTIMIZER_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(promptOptimizerFlag);
