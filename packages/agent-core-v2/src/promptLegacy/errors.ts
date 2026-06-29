/**
 * `promptLegacy` domain error codes — v1-compatible prompt failures.
 */

export const PromptLegacyErrors = {
  codes: {
    PROMPT_NOT_FOUND: 'prompt.not_found',
    SESSION_BUSY: 'session.busy',
    PROMPT_ALREADY_COMPLETED: 'prompt.already_completed',
  },
} as const;
