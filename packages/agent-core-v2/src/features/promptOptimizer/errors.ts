import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const PromptOptimizerErrors = {
  codes: {
    PROMPT_OPTIMIZER_DISABLED: 'prompt_optimizer.disabled',
    PROMPT_OPTIMIZER_EMPTY_DRAFT: 'prompt_optimizer.empty_draft',
    PROMPT_OPTIMIZER_NO_OUTPUT: 'prompt_optimizer.no_output',
    PROMPT_OPTIMIZER_BUSY: 'prompt_optimizer.busy',
  },
  retryable: ['prompt_optimizer.busy'],
  info: {
    'prompt_optimizer.disabled': {
      title: 'Prompt optimizer is disabled',
      retryable: false,
      public: true,
      action: 'Turn on the prompt_optimizer experimental flag to use it.',
    },
    'prompt_optimizer.empty_draft': {
      title: 'Prompt draft is empty',
      retryable: false,
      public: true,
      action: 'Provide a prompt draft to optimize.',
    },
    'prompt_optimizer.no_output': {
      title: 'Prompt optimizer returned no output',
      retryable: true,
      public: true,
      action: 'Retry the optimization.',
    },
    'prompt_optimizer.busy': {
      title: 'Prompt rewrite already in progress',
      retryable: true,
      public: true,
      action: 'Wait for the current rewrite to finish before starting another.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PromptOptimizerErrors);
