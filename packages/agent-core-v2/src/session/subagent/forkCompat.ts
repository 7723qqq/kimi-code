/**
 * Subagent fork compatibility checks.
 *
 * `fork: true` on the Agent / AgentSwarm tool means "start a subagent from
 * the caller's snapshot" (profile, model, tool set, conversation history).
 * Because the fork inherits everything from the caller, several parameters
 * that the spawn path supports are no longer meaningful and must be
 * rejected up front.
 */

import {
  FORK_CANNOT_COMBINE_WITH_MODEL,
  FORK_CANNOT_COMBINE_WITH_RESUME,
  FORK_CANNOT_COMBINE_WITH_SUBAGENT_TYPE,
} from '#/agent/tools/agent/agent';

/**
 * A subset of the SubagentToolInput that fork-compatibility checks inspect.
 * Keeping this narrow lets the same helper serve both Agent and AgentSwarm
 * without pulling in agent-private types.
 */
export interface ForkCompatInputLike {
  readonly fork?: boolean;
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly model?: string;
}

/**
 * Validate a fork request. Returns `undefined` when the request is
 * compatible, or a user-facing error message when one of the disallow
 * rules fires.
 *
 * Rules:
 * 1. fork + resume → cannot resume an existing agent AND fork a new one
 * 2. fork + subagent_type → fork inherits the caller's profile
 * 3. fork + model → fork inherits the caller's model
 *
 * The checks run in that order so the first violation wins (no chained
 * errors), matching the existing single-error style of the Agent tool.
 */
export function forkIncompatibility(args: ForkCompatInputLike): string | undefined {
  if (args.fork !== true) return undefined;

  if (args.resume !== undefined && args.resume.trim().length > 0) {
    return FORK_CANNOT_COMBINE_WITH_RESUME;
  }
  if (args.subagent_type !== undefined && args.subagent_type.length > 0) {
    return FORK_CANNOT_COMBINE_WITH_SUBAGENT_TYPE;
  }
  if (args.model !== undefined && args.model.length > 0) {
    return FORK_CANNOT_COMBINE_WITH_MODEL;
  }
  return undefined;
}
