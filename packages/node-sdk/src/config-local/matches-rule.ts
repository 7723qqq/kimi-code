/**
 * Localized port of v1's permission-pattern DSL parser
 * (`agent-core/src/agent/permission/matches-rule.ts`) — the `parsePattern`
 * half used by the local config schema to validate permission rules. The
 * native/Rust fast path and the glob matching are not ported: the schema
 * only needs the syntax check.
 */

import { t } from '@moonshot-ai/kimi-i18n';

export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

/**
 * Parse a DSL pattern. Throws on malformed input (missing closing paren,
 * empty tool name).
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error(t('v2Errors.permissionPatternEmpty'));
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(t('v2Errors.permissionPatternMissingParen', { pattern }));
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(t('v2Errors.permissionPatternEmptyTool', { pattern }));
  }
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}
