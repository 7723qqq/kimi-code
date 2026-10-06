/**
 * ACP `session/request_permission` ↔ agent-core-v2 approval mappers.
 *
 * Pure functions that translate an `ApprovalRequest` (raised by the engine's
 * `AgentPermissionGate` and surfaced through the `interaction` kernel) into the
 * ACP `PermissionOption[]` + `ToolCallUpdate` surfaced to the client, and the
 * client's `RequestPermissionResponse` back into an `ApprovalResponse`. Kept
 * free of IO so the mappings stay unit-testable without a live connection.
 */

import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  SessionApprovalRequest as ApprovalRequest,
  SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';

import { displayBlockToAcpContent } from './convert';
import { acpToolCallId } from './events-map';

/**
 * Canonical option ids surfaced to the ACP client.
 *
 * The wire-level `PermissionOption.optionId` is opaque to the client (it
 * round-trips back in `RequestPermissionResponse.outcome.optionId`), so the
 * host is free to pick any stable string. These literals are the single source
 * of truth on both the build- and the parse-side; tests import them rather
 * than re-typing the strings.
 */
export const APPROVE_ONCE_OPTION_ID = 'approve_once';
export const APPROVE_ALWAYS_OPTION_ID = 'approve_always';
export const REJECT_OPTION_ID = 'reject';

/**
 * `plan_review` optionId namespace. Picked deliberately so the `plan_*` prefix
 * never collides with the canonical `approve_*` / `reject` namespace nor with
 * the question bridge's `q{n}_*` namespace.
 *
 *  - `plan_opt_<i>` — one per `display.options[i]` (rendered as `allow_once`
 *    so the user can pick A / B / C without re-entering the prompt).
 *  - `plan_approve` — fallback approve when `display.options` is absent or
 *    has fewer than two entries.
 *  - `plan_revise` / `plan_reject_and_exit` — the two reject-side exits.
 */
export const PLAN_APPROVE_OPTION_ID = 'plan_approve';
export const PLAN_REVISE_OPTION_ID = 'plan_revise';
export const PLAN_REJECT_AND_EXIT_OPTION_ID = 'plan_reject_and_exit';

function planOptOptionId(i: number): string {
  return `plan_opt_${i}`;
}

/**
 * `spec_review` optionId namespace, mirroring the `plan_*` one above.
 *
 * A spec review offers the same choice shape as a plan review — the agent may
 * pass up to three alternative approaches — so it gets the same option set.
 * Without this the spec falls through to {@link CANONICAL_OPTIONS}, which
 * cannot express "Revise" and offers an "approve for this session" action the
 * spec flow does not define.
 */
export const SPEC_APPROVE_OPTION_ID = 'spec_approve';
export const SPEC_REVISE_OPTION_ID = 'spec_revise';
export const SPEC_REJECT_AND_EXIT_OPTION_ID = 'spec_reject_and_exit';

function specOptOptionId(i: number): string {
  return `spec_opt_${i}`;
}

const REVIEW_OPTION_IDS = new Set([
  PLAN_APPROVE_OPTION_ID,
  PLAN_REVISE_OPTION_ID,
  PLAN_REJECT_AND_EXIT_OPTION_ID,
  SPEC_APPROVE_OPTION_ID,
  SPEC_REVISE_OPTION_ID,
  SPEC_REJECT_AND_EXIT_OPTION_ID,
]);

/**
 * The review-style option list shared by `plan_review` and `spec_review`:
 * one `allow_once` per offered approach, or a single approve fallback, plus the
 * two `reject_once` exits. Each kind keeps its own optionId prefix so the
 * response mapper can tell which flow produced it.
 */
function reviewOptions(
  options: readonly { readonly label: string }[] | undefined,
  ids: {
    readonly opt: (i: number) => string;
    readonly approve: string;
    readonly revise: string;
    readonly rejectAndExit: string;
  },
): readonly PermissionOption[] {
  const approveOptions: PermissionOption[] =
    options !== undefined && options.length >= 2
      ? options.map((opt, i) => ({
          optionId: ids.opt(i),
          name: opt.label,
          kind: 'allow_once' as const,
        }))
      : [{ optionId: ids.approve, name: 'Approve', kind: 'allow_once' as const }];
  return [
    ...approveOptions,
    { optionId: ids.revise, name: 'Revise', kind: 'reject_once' as const },
    {
      optionId: ids.rejectAndExit,
      name: 'Reject and Exit',
      kind: 'reject_once' as const,
    },
  ];
}

/**
 * The three canonical permission options surfaced to the ACP client for a
 * non-`plan_review` approval prompt.
 *
 * Order is load-bearing: ACP clients render options top-to-bottom, so
 * allow-once is the primary action, allow-always the secondary, and reject the
 * terminal/dangerous action that should be hardest to click by accident.
 */
const CANONICAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: APPROVE_ONCE_OPTION_ID, name: 'Approve once', kind: 'allow_once' },
  {
    optionId: APPROVE_ALWAYS_OPTION_ID,
    name: 'Approve for this session',
    kind: 'allow_always',
  },
  { optionId: REJECT_OPTION_ID, name: 'Reject', kind: 'reject_once' },
];

/**
 * Build the {@link PermissionOption}[] surfaced to the ACP client for an
 * approval prompt.
 *
 * When the request's display block carries `kind: 'plan_review'`, the options
 * expand to one `allow_once` per `display.options[i]` (A / B / C) — or a
 * single `plan_approve` fallback when the policy did not supply ≥ 2 discrete
 * options — plus the two `reject_once` exits `Revise` and `Reject and Exit`.
 *
 * For every other display kind, returns the canonical 3-option list.
 */
export function approvalRequestToPermissionOptions(
  req: ApprovalRequest,
): readonly PermissionOption[] {
  if (req.display.kind === 'plan_review') {
    return reviewOptions(req.display.options, {
      opt: planOptOptionId,
      approve: PLAN_APPROVE_OPTION_ID,
      revise: PLAN_REVISE_OPTION_ID,
      rejectAndExit: PLAN_REJECT_AND_EXIT_OPTION_ID,
    });
  }
  if (req.display.kind === 'spec_review') {
    return reviewOptions(req.display.options, {
      opt: specOptOptionId,
      approve: SPEC_APPROVE_OPTION_ID,
      revise: SPEC_REVISE_OPTION_ID,
      rejectAndExit: SPEC_REJECT_AND_EXIT_OPTION_ID,
    });
  }
  return CANONICAL_OPTIONS;
}

/**
 * Translate an ACP {@link RequestPermissionResponse} into an engine
 * {@link ApprovalResponse}.
 *
 * Decision mapping (canonical / non-plan_review path):
 *  - `cancelled` outcome → `decision: 'cancelled'`.
 *  - `approve_once`  → `decision: 'approved'` (no scope, one-shot).
 *  - `approve_always` → `decision: 'approved'` with `scope: 'session'` so the
 *    engine installs a session-runtime allow rule for subsequent invocations.
 *  - `reject`        → `decision: 'rejected'`.
 *  - Legacy Python kimi-cli (< v0.9.0) ids `approve` / `approve_for_session`
 *    map like `approve_once` / `approve_always` so custom ACP clients built
 *    against the old SDK are not silently rejected.
 *  - Any other optionId → defensive `rejected` (rejecting is strictly safer
 *    than approving for an unknown id).
 *
 * For `plan_review`, the `plan_opt_<i>` / `plan_approve` / `plan_revise` /
 * `plan_reject_and_exit` optionIds map directly to the discriminator, and the
 * matched option's label is attached as `selectedLabel` so the downstream
 * policy can drive its branch off a stable string.
 */
export function permissionResponseToApprovalResponse(
  req: ApprovalRequest,
  response: RequestPermissionResponse,
): ApprovalResponse {
  if (response.outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }
  const optionId = response.outcome.optionId;
  if (req.display.kind === 'plan_review') {
    return mapReviewOptionId(req.display.options, optionId, {
      opt: /^plan_opt_(\d+)$/,
      approve: PLAN_APPROVE_OPTION_ID,
      revise: PLAN_REVISE_OPTION_ID,
      rejectAndExit: PLAN_REJECT_AND_EXIT_OPTION_ID,
    });
  }
  if (req.display.kind === 'spec_review') {
    return mapReviewOptionId(req.display.options, optionId, {
      opt: /^spec_opt_(\d+)$/,
      approve: SPEC_APPROVE_OPTION_ID,
      revise: SPEC_REVISE_OPTION_ID,
      rejectAndExit: SPEC_REJECT_AND_EXIT_OPTION_ID,
    });
  }
  switch (optionId) {
    case APPROVE_ONCE_OPTION_ID:
    // Legacy Python kimi-cli (< v0.9.0) used 'approve' as the allow-once
    // optionId. Keep accepting it so custom ACP clients built against the
    // old SDK are not silently rejected.
    case 'approve':
      return { decision: 'approved' };
    case APPROVE_ALWAYS_OPTION_ID:
    // Legacy Python kimi-cli (< v0.9.0) used 'approve_for_session' as the
    // allow-always optionId. Same backward-compatibility rationale as the
    // 'approve' branch above.
    case 'approve_for_session':
      return { decision: 'approved', scope: 'session' };
    case REJECT_OPTION_ID:
      return { decision: 'rejected' };
    default:
      // Unknown optionId — defensive fallback. Reject is safer than approve.
      return { decision: 'rejected' };
  }
}

function mapReviewOptionId(
  options: readonly { readonly label: string }[] | undefined,
  optionId: string,
  ids: {
    readonly opt: RegExp;
    readonly approve: string;
    readonly revise: string;
    readonly rejectAndExit: string;
  },
): ApprovalResponse {
  if (optionId === ids.approve) {
    return { decision: 'approved' };
  }
  if (optionId === ids.revise) {
    return { decision: 'rejected', selectedLabel: 'Revise' };
  }
  if (optionId === ids.rejectAndExit) {
    return { decision: 'rejected', selectedLabel: 'Reject and Exit' };
  }
  const match = ids.opt.exec(optionId);
  if (match) {
    const i = Number(match[1]);
    if (options !== undefined && Number.isInteger(i) && i >= 0 && i < options.length) {
      return { decision: 'approved', selectedLabel: options[i]!.label };
    }
    return { decision: 'rejected' };
  }
  return { decision: 'rejected' };
}

/**
 * Build the ACP {@link ToolCallUpdate} that scopes a permission request to a
 * specific in-flight tool call.
 *
 * The `toolCallId` is the prefixed ACP wire id `${turnId}:${rawId}` — matching
 * the id format used by all other tool_call/tool_call_update notifications —
 * so the client can correlate the approval prompt with the tool card it
 * already rendered. If `req.turnId` is `undefined` the raw id is used as a
 * defensive fallback (in practice approvals always fire after
 * `tool.call.started`, so the fallback is effectively unreachable).
 *
 * Content shape:
 *  - If `req.display` produces a diff-bearing entry, prepend it so the diff /
 *    plan card is the headline of the approval prompt.
 *  - Always append a human-readable action summary
 *    (`"Requesting approval to ${req.action}"`) so the prompt is never empty.
 */
export function buildPermissionToolCallUpdate(req: ApprovalRequest): ToolCallUpdate {
  const rawId = req.toolCallId ?? req.toolName;
  const toolCallId = req.turnId !== undefined ? acpToolCallId(req.turnId, rawId) : rawId;
  const content: ToolCallContent[] = [];
  const headlineEntry = displayBlockToAcpContent(req.display);
  if (headlineEntry !== null) {
    content.push(headlineEntry);
  }
  content.push({
    type: 'content',
    content: { type: 'text', text: `Requesting approval to ${req.action}` },
  });
  return {
    toolCallId,
    title: req.toolName,
    content,
  };
}

/**
 * Look up the matched {@link PermissionOption}'s display name for the given
 * response and return a new {@link ApprovalResponse} carrying `selectedLabel`.
 * Returns the input unchanged when the outcome was `cancelled`, the optionId
 * is unknown, or it is in the `plan_*` namespace (the plan_review branch
 * attaches `selectedLabel` inside the mapper already).
 *
 * Pure: returns a fresh object (never mutates the input).
 */
export function attachSelectedLabel(
  response: RequestPermissionResponse,
  approval: ApprovalResponse,
  options: readonly PermissionOption[],
): ApprovalResponse {
  const outcome = response.outcome;
  if (outcome.outcome !== 'selected') return approval;
  if (
    outcome.optionId.startsWith('plan_opt_') ||
    outcome.optionId.startsWith('spec_opt_') ||
    REVIEW_OPTION_IDS.has(outcome.optionId)
  ) {
    return approval;
  }
  const matched = options.find((o) => o.optionId === outcome.optionId);
  if (!matched) return approval;
  return { ...approval, selectedLabel: matched.name };
}
