/**
 * Public error-code registry (`ErrorCodes`, `ErrorCode`) and per-code metadata
 * (`ERROR_INFO`, `errorInfo`) surfaced to SDK/RPC consumers.
 */

export const ErrorCodes = {
  INTERNAL: 'internal',
  NOT_IMPLEMENTED: 'not_implemented',
  CANCELED: 'canceled',
  LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  CONTEXT_OVERFLOW: 'context.overflow',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export const ERROR_INFO = {
  internal: {
    title: 'Internal error',
    retryable: false,
    public: true,
    action: 'Inspect logs or report the issue with diagnostics.',
  },
  not_implemented: {
    title: 'Not implemented',
    retryable: false,
    public: true,
    action: 'This feature is not implemented yet.',
  },
  canceled: {
    title: 'Canceled',
    retryable: false,
    public: true,
    action: 'The operation was canceled by the user or an abort signal.',
  },
  'loop.max_steps_exceeded': {
    title: 'Loop max steps exceeded',
    retryable: false,
    public: true,
    action: 'Raise the max step limit or inspect the tool loop for non-convergence.',
  },
  'context.overflow': {
    title: 'Context overflow',
    retryable: true,
    public: true,
    action: 'Compact the conversation or retry with fewer tokens.',
  },
  'provider.rate_limit': {
    title: 'Provider rate limit',
    retryable: true,
    public: true,
    action: 'Retry after the provider rate limit resets.',
  },
  'provider.auth_error': {
    title: 'Provider authentication failed',
    retryable: false,
    public: true,
    action: 'Check provider credentials and authentication configuration.',
  },
  'auth.login_required': {
    title: 'Login required',
    retryable: false,
    public: true,
    action: 'Run /login to authenticate with the OAuth provider.',
  },
} as const satisfies Record<ErrorCode, ErrorInfo>;

export function errorInfo(code: ErrorCode): ErrorInfo {
  return ERROR_INFO[code];
}
