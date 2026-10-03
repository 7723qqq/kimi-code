import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const approvalDecisionSchema = z.enum(['approved', 'rejected', 'cancelled']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalScopeSchema = z.enum(['session']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export const approvalRequestSchema = z.object({
  approval_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  action: z.string(),
  tool_input_display: z.unknown(),
  /**
   * Why the engine is asking, already rendered in the host's locale — the local
   * permission policy that fired ("access to sensitive file …"). Absent when
   * the engine has no policy-specific explanation, in which case the host
   * describes the call from `tool_input_display` as before.
   */
  reason: z.string().optional(),
  /**
   * The user's own ask rule that fired, when one did — what "approve for this
   * session" would remember. Absent when no such rule did, so a client can tell
   * "remembering is possible" from "there is nothing to remember".
   *
   * Declared here rather than left to pass through: zod strips unknown keys, so
   * a field absent from this schema is silently dropped for every consumer that
   * parses through it.
   */
  session_approval_rule: z.string().optional(),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalResponseSchema = z.object({
  decision: approvalDecisionSchema,
  scope: approvalScopeSchema.optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
