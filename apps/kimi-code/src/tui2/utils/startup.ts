/**
 * Startup-notice composition and OAuth-login-required classification used by
 * the startup banner / auth flow.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import { OAUTH_LOGIN_REQUIRED_CODE } from '../constant/kimi-tui';

export function combineStartupNotice(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (existing !== undefined && next !== undefined) {
    return `${existing}\n${next}`;
  }
  return existing ?? next;
}

export function isOAuthLoginRequiredError(error: unknown): boolean {
  return (error as { readonly code?: unknown }).code === OAUTH_LOGIN_REQUIRED_CODE;
}
