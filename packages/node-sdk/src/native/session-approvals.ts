/**
 * Session-scoped approval memory.
 *
 * v2 `permissionRulesOps.ts` promotes a pattern into `sessionApprovalRulePatterns`
 * only when the response says `scope: session`, and `sessionApprovalRule` is
 * present. The functions here are that rule, extracted so the *behaviour* can be
 * tested: the alternative is asserting that a field travelled through the wire,
 * which passes whether or not the user ever stops being asked.
 *
 * The granularity is the user's own ask rule, never the tool name. Approving
 * `Bash` for a session would allow every later Bash call, including the
 * dangerous ones the rule exists to catch.
 */

/**
 * Whether a request can be answered from what the user already approved.
 *
 * A request that names no rule can never be auto-approved: there would be
 * nothing to match it against, and matching on the tool name instead is the
 * over-grant this design exists to avoid.
 */
export function isApprovedForSession(
  sessionApprovalRule: string | undefined,
  approvedRules: readonly string[],
): boolean {
  if (sessionApprovalRule === undefined || sessionApprovalRule.length === 0) return false;
  return approvedRules.includes(sessionApprovalRule);
}

/**
 * The rules to remember after a response, or the same list when nothing changed.
 *
 * Only an approval carrying `scope: session` is remembered. A one-shot approval
 * says nothing about the next call, and a rejection must never be recorded — a
 * remembered refusal would silently deny work the user has not been asked about.
 */
export function rememberSessionApproval(
  sessionApprovalRule: string | undefined,
  response: { readonly decision: string; readonly scope?: string | undefined },
  approvedRules: readonly string[],
): readonly string[] {
  if (response.decision !== 'approved') return approvedRules;
  if (response.scope !== 'session') return approvedRules;
  if (sessionApprovalRule === undefined || sessionApprovalRule.length === 0) return approvedRules;
  if (approvedRules.includes(sessionApprovalRule)) return approvedRules;
  return [...approvedRules, sessionApprovalRule];
}