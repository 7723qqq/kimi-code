/**
 * Prompt Optimizer — redaction for anything written out.
 *
 * A provider error can echo the request it rejected, and a key can end up in an
 * error string. Both would be persisted by a report, so every free-text field
 * that reaches a report or a log passes through here first.
 */

/**
 * Shapes that mean "credential material" rather than "text about credentials".
 *
 * Deliberately broad on the value side: a masked fragment is fine, the real key
 * is not, and a report is read far more often than a redaction is inspected.
 */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, replacement: '[redacted-key]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: '[redacted-credential]' },
  {
    pattern: /\bx-api-key\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: 'x-api-key [redacted]',
  },
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|secret|password)\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: '$1=[redacted]',
  },
  { pattern: /\bAKIA[0-9A-Z]{12,}\b/g, replacement: '[redacted-key]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: '[redacted-key]' },
];

/** Masks credential-shaped material in place. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replaceAll(pattern, replacement);
  }
  return out;
}

/** Whether a string still looks like it carries a secret; used by report tests. */
export function containsSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    // Stateful `lastIndex` on a /g regex would make repeated calls inconsistent.
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Default cap for a model answer kept in a report, in characters. */
export const RAW_OUTPUT_LIMIT = 2000;

/**
 * Keep the head of a long answer, redacted.
 *
 * A report is a summary of what happened, not a transcript: the whole answer
 * would carry far more text than any reader of the report needs, and it is the
 * field most likely to contain something that should not be persisted.
 */
export function truncateForReport(text: string, limit: number = RAW_OUTPUT_LIMIT): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit)}…[truncated ${redacted.length - limit} chars]`;
}
