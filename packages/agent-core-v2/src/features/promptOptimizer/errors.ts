import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const PromptOptimizerErrors = {
  codes: {
    PROMPT_OPTIMIZER_DISABLED: 'prompt_optimizer.disabled',
    PROMPT_OPTIMIZER_EMPTY_DRAFT: 'prompt_optimizer.empty_draft',
    PROMPT_OPTIMIZER_NO_OUTPUT: 'prompt_optimizer.no_output',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PromptOptimizerErrors);
