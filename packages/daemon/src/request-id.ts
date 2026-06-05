/**
 * `request_id` resolution at the daemon's REST boundary (W4.3 / P0.13).
 *
 * Delegates to `parseOrGenerateRequestId` from `@moonshot-ai/protocol`, which:
 *   - returns a bare 26-char ULID per PLAN §P7 (no `req_` prefix);
 *   - validates client-supplied `X-Request-Id` is a real ULID and regenerates
 *     a fresh one on malformed input (log hygiene + DoS surface — operator
 *     log files would otherwise carry attacker-controlled strings verbatim).
 *
 * Wire format change vs. the pre-W4 walking-skeleton daemon:
 *   - OLD: `req_${ulid()}` minted; client-supplied header echoed verbatim
 *     regardless of format.
 *   - NEW: bare ULID minted; client-supplied header echoed ONLY if it
 *     passes `ulid.isValid`.
 *
 * Existing clients that relied on the `req_…` echo will see a freshly-minted
 * bare ULID instead. This is the W1 reviewer's recommendation and is
 * documented in W4 STATUS §Decisions.
 */

import { parseOrGenerateRequestId } from '@moonshot-ai/protocol';

const REQUEST_ID_HEADER = 'x-request-id';

export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  return parseOrGenerateRequestId(supplied);
}
