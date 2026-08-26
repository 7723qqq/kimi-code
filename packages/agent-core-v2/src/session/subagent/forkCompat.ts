export const FORK_CANNOT_COMBINE_WITH_RESUME =
  'Cannot use fork with resume — fork creates a new subagent from the caller\'s snapshot; resume targets an existing agent by id.';
export const FORK_CANNOT_COMBINE_WITH_SUBAGENT_TYPE =
  'Cannot use fork with subagent_type — a forked subagent inherits the caller\'s profile. Omit subagent_type to use fork.';
export const FORK_CANNOT_COMBINE_WITH_MODEL =
  'Cannot use fork with model — a forked subagent inherits the caller\'s model. Omit model to use fork.';

export interface ForkCompatInputLike {
  readonly fork?: boolean;
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly model?: string;
}

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
