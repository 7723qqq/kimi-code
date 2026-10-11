import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const PromptOptimizerErrors = {
  codes: {
    PROMPT_OPTIMIZER_DISABLED: 'prompt_optimizer.disabled',
    PROMPT_OPTIMIZER_EMPTY_DRAFT: 'prompt_optimizer.empty_draft',
    PROMPT_OPTIMIZER_NO_OUTPUT: 'prompt_optimizer.no_output',
    PROMPT_OPTIMIZER_BUSY: 'prompt_optimizer.busy',
    PROMPT_OPTIMIZER_OUTPUT_TOO_LONG: 'prompt_optimizer.output_too_long',
  },
  retryable: ['prompt_optimizer.busy'],
  info: {
    'prompt_optimizer.disabled': {
      retryable: false,
      public: true,
    },
    'prompt_optimizer.empty_draft': {
      retryable: false,
      public: true,
    },
    'prompt_optimizer.no_output': {
      retryable: true,
      public: true,
    },
    'prompt_optimizer.busy': {
      retryable: true,
      public: true,
    },
    'prompt_optimizer.output_too_long': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PromptOptimizerErrors);
